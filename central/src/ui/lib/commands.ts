import { api } from '../api';
import { act } from './query';
import type { CommandResult } from '../../shared/types';

/**
 * Send a device command. Errors (including `{ok:false}` results) become toasts.
 * Returns the result, or undefined when it failed.
 */
export function sendCommand(
  deviceId: string,
  command: string,
  args?: Record<string, unknown>,
  opts: { success?: string; error?: string; invalidate?: string[] | false } = {},
): Promise<CommandResult | undefined> {
  return act(
    async () => {
      const r = await api.devices.command(deviceId, command, args);
      if (!r.ok) throw new Error(r.error ?? 'The device didn’t accept the command.');
      return r;
    },
    {
      success: opts.success,
      error: opts.error ?? 'Command failed',
      invalidate: opts.invalidate === false ? [] : opts.invalidate ?? [`device:${deviceId}`, 'devices', 'site:'],
    },
  );
}
