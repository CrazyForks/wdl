import { WorkerEntrypoint } from "cloudflare:workers";
import {
  deleteAlarmIndex,
  setAlarmIndex,
} from "do-runtime-alarm";

/**
 * @typedef {{ ns: string, worker: string, version: string, doStorageId: string }} AlarmProps
 * @typedef {{ className: string, objectName: string, scheduledTime?: unknown, retryCount?: unknown, token?: unknown }} AlarmInput
 * @typedef {{ ctx: { props?: Partial<AlarmProps> }, env: Record<string, unknown> }} AlarmBinding
 */

/** @param {AlarmBinding} binding */
function alarmBindingProps(binding) {
  const props = binding.ctx.props || {};
  return /** @type {AlarmProps} */ ({
    ns: props.ns,
    worker: props.worker,
    version: props.version,
    doStorageId: props.doStorageId,
  });
}

/** @param {unknown} input */
function alarmInput(input) {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? /** @type {Record<string, unknown>} */ (input)
    : {};
  return /** @type {AlarmInput} */ (record);
}

export class DoAlarmBinding extends WorkerEntrypoint {
  /** @param {unknown} input */
  async setAlarmIndex(input) {
    return await setAlarmIndex(this.env, alarmBindingProps(/** @type {AlarmBinding} */ (/** @type {unknown} */ (this))), alarmInput(input));
  }

  /** @param {unknown} input */
  async deleteAlarmIndex(input) {
    return await deleteAlarmIndex(this.env, alarmBindingProps(/** @type {AlarmBinding} */ (/** @type {unknown} */ (this))), alarmInput(input));
  }
}
