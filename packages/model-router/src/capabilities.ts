export type ModelCapabilities = {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  computerUse: boolean;
};

export const defaultCapabilities: ModelCapabilities = {
  streaming: true,
  tools: false,
  vision: false,
  reasoning: false,
  computerUse: false,
};
