import type { RawData, WebSocket } from "ws";
import type { LocalToolManifest } from "@muse/shared";

export type WorkspaceGrant = {
  workspaceId: string;
  displayName: string;
  attachedAt: Date;
};

export type RegisteredDevice = {
  deviceId: string;
  userId: string;
  name: string;
  platform: string;
  appVersion?: string;
  socket: WebSocket;
  connectedAt: Date;
  lastSeenAt: Date;
  manifests: LocalToolManifest[];
  workspaces: Map<string, WorkspaceGrant>;
};

export type DeviceRegistrySnapshot = {
  deviceId: string;
  userId: string;
  name: string;
  platform: string;
  appVersion?: string;
  connectedAt: string;
  lastSeenAt: string;
  tools: string[];
  workspaces: Array<{
    workspaceId: string;
    displayName: string;
    attachedAt: string;
  }>;
};

export class DeviceRegistry {
  private readonly devicesById = new Map<string, RegisteredDevice>();
  private readonly userDeviceIds = new Map<string, Set<string>>();

  register(input: {
    deviceId: string;
    userId: string;
    name: string;
    platform: string;
    appVersion?: string;
    socket: WebSocket;
  }): RegisteredDevice {
    this.unregister(input.deviceId);

    const now = new Date();
    const device: RegisteredDevice = {
      deviceId: input.deviceId,
      userId: input.userId,
      name: input.name,
      platform: input.platform,
      appVersion: input.appVersion,
      socket: input.socket,
      connectedAt: now,
      lastSeenAt: now,
      manifests: [],
      workspaces: new Map(),
    };

    this.devicesById.set(input.deviceId, device);
    const userDevices = this.userDeviceIds.get(input.userId) ?? new Set();
    userDevices.add(input.deviceId);
    this.userDeviceIds.set(input.userId, userDevices);

    return device;
  }

  markReady(deviceId: string, manifests: LocalToolManifest[]): void {
    const device = this.devicesById.get(deviceId);
    if (!device) {
      return;
    }

    device.manifests = manifests;
    device.lastSeenAt = new Date();
  }

  attachWorkspace(input: {
    deviceId: string;
    workspaceId: string;
    displayName: string;
  }): void {
    const device = this.devicesById.get(input.deviceId);
    if (!device) {
      return;
    }

    device.workspaces.set(input.workspaceId, {
      workspaceId: input.workspaceId,
      displayName: input.displayName,
      attachedAt: new Date(),
    });
    device.lastSeenAt = new Date();
  }

  detachWorkspace(deviceId: string, workspaceId: string): void {
    const device = this.devicesById.get(deviceId);
    if (!device) {
      return;
    }

    device.workspaces.delete(workspaceId);
    device.lastSeenAt = new Date();
  }

  touch(deviceId: string): void {
    const device = this.devicesById.get(deviceId);
    if (device) {
      device.lastSeenAt = new Date();
    }
  }

  getDeviceForUser(userId: string, deviceId: string): RegisteredDevice | null {
    const device = this.devicesById.get(deviceId);
    if (!device || device.userId !== userId) {
      return null;
    }

    return device;
  }

  listUserDevices(userId: string): DeviceRegistrySnapshot[] {
    const ids = this.userDeviceIds.get(userId);
    if (!ids) {
      return [];
    }

    return [...ids]
      .map((id) => this.devicesById.get(id))
      .filter((device): device is RegisteredDevice => Boolean(device))
      .map((device) => ({
        deviceId: device.deviceId,
        userId: device.userId,
        name: device.name,
        platform: device.platform,
        appVersion: device.appVersion,
        connectedAt: device.connectedAt.toISOString(),
        lastSeenAt: device.lastSeenAt.toISOString(),
        tools: device.manifests.map((manifest) => manifest.name),
        workspaces: [...device.workspaces.values()].map((workspace) => ({
          workspaceId: workspace.workspaceId,
          displayName: workspace.displayName,
          attachedAt: workspace.attachedAt.toISOString(),
        })),
      }));
  }

  unregister(deviceId: string): RegisteredDevice | null {
    const device = this.devicesById.get(deviceId);
    if (!device) {
      return null;
    }

    this.devicesById.delete(deviceId);
    const userDevices = this.userDeviceIds.get(device.userId);
    userDevices?.delete(deviceId);
    if (userDevices?.size === 0) {
      this.userDeviceIds.delete(device.userId);
    }

    return device;
  }
}

export function parseSocketMessage(data: RawData): unknown {
  return JSON.parse(data.toString("utf8"));
}
