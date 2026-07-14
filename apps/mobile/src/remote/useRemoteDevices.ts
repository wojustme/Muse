import { useCallback, useEffect, useState } from "react";
import { authHeaders } from "../auth/client";
import { resolveServerUrl } from "../config/server-url";

// 服务端 GET /api/local-tools/devices 返回的设备快照。
// 形状对齐 apps/server/src/local-tools/device-registry.ts 的 DeviceRegistrySnapshot。
export type RemoteWorkspace = {
  workspaceId: string;
  displayName: string;
  attachedAt: string;
};

export type RemoteDevice = {
  deviceId: string;
  userId: string;
  name: string;
  platform: string;
  appVersion?: string;
  connectedAt: string;
  lastSeenAt: string;
  tools: string[];
  workspaces: RemoteWorkspace[];
};

// 手机端当前选择的"借用桌面工具"目标：某台在线设备 + 其一个工作区。
export type RemoteSelection = {
  deviceId: string;
  workspaceId: string;
  workspaceName: string;
  deviceName: string;
};

export type UseRemoteDevices = {
  devices: RemoteDevice[];
  loading: boolean;
  error: string;
  selection: RemoteSelection | null;
  refresh: () => Promise<void>;
  select: (selection: RemoteSelection | null) => void;
};

async function fetchDevices(): Promise<RemoteDevice[]> {
  const response = await fetch(
    `${resolveServerUrl()}/api/local-tools/devices`,
    {
      headers: authHeaders(),
    },
  );
  if (!response.ok) {
    throw new Error(`获取远程设备失败（${response.status}）`);
  }
  const data = (await response.json()) as { devices?: RemoteDevice[] };
  return data.devices ?? [];
}

// 拉取当前用户在线的桌面设备，并维护"借用工具"的选择状态。
// 选择的设备/工作区离线（刷新后不在列表里）时自动清空选择，避免带上失效的 deviceId。
export function useRemoteDevices(enabled: boolean): UseRemoteDevices {
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<RemoteSelection | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchDevices();
      setDevices(next);
      setSelection((current) => {
        if (!current) {
          return current;
        }
        const device = next.find((item) => item.deviceId === current.deviceId);
        const stillOnline = device?.workspaces.some(
          (workspace) => workspace.workspaceId === current.workspaceId,
        );
        return stillOnline ? current : null;
      });
    } catch (fetchError) {
      setError(
        fetchError instanceof Error ? fetchError.message : "获取远程设备失败",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return {
    devices,
    loading,
    error,
    selection,
    refresh,
    select: setSelection,
  };
}
