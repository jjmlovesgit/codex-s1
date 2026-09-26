import * as ort from "onnxruntime-node";

export function getExecutionProviders(): ort.InferenceSession.ExecutionProviderConfig[] {
  const targetDevice = process.env.S1_PRECOG_DEVICE?.toLowerCase();

  if (targetDevice === "cuda") {
    // Explicit opt-in for multi-GPU workstations.
    return ["cuda", "cpu"];
  }

  if (targetDevice === "directml") {
    // Windows DirectML opt-in.
    return ["directml", "cpu"];
  }

  // Hard-pinned default: zero VRAM contention and zero driver dependencies.
  return ["cpu"];
}

export async function createLayaSession(modelPath: string): Promise<ort.InferenceSession> {
  return await ort.InferenceSession.create(modelPath, {
    executionProviders: getExecutionProviders(),
    graphOptimizationLevel: "all",
    executionMode: "parallel",
  });
}
