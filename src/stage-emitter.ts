import { performance } from "node:perf_hooks";

const STAGE_PROGRESS_DISABLED = process.env.MIXIN_STAGE_PROGRESS_OFF === "1";

export type StageEmitter = (
  stage: string,
  meta?: Record<string, unknown>
) => Promise<void>;

export const NOOP_STAGE_EMITTER: StageEmitter = async () => {
  /* noop */
};

export type StageEmitterExtra = {
  requestId?: string | number;
  sendNotification?: (notification: { method: string; params?: unknown }) => Promise<void>;
};

export type StageEmitterOptions = {
  disabled?: boolean;
};

export function makeStageEmitter(
  extra: StageEmitterExtra | undefined,
  options: StageEmitterOptions = {}
): StageEmitter {
  if (options.disabled ?? STAGE_PROGRESS_DISABLED) {
    return NOOP_STAGE_EMITTER;
  }
  if (!extra) {
    return NOOP_STAGE_EMITTER;
  }
  const requestId = extra.requestId;
  const sendNotification = extra.sendNotification;
  if (requestId === undefined || typeof sendNotification !== "function") {
    return NOOP_STAGE_EMITTER;
  }

  return async (stage, meta) => {
    await sendNotification({
      method: "$/stageUpdate",
      params: {
        stage,
        meta: meta ?? null,
        t: performance.now(),
        requestId
      }
    });
  };
}
