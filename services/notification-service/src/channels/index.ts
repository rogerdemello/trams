import type { Config, Logger } from '@trams/shared';
import { ConsoleChannel } from './console-channel.js';
import { SmtpChannel } from './smtp-channel.js';
import type { NotificationChannel } from './types.js';

export { ConsoleChannel, RecordingChannel } from './console-channel.js';
export { SmtpChannel, classifySmtpError } from './smtp-channel.js';
export {
  PermanentDeliveryError,
  TransientDeliveryError,
  isPermanentFailure,
  type NotificationChannel,
  type NotificationMessage,
} from './types.js';

/**
 * Select the delivery channel from configuration.
 *
 * A switch on a validated enum, so an unknown value is rejected by the config
 * loader at boot rather than falling through to a silent default here. The
 * exhaustiveness check below means adding a channel to the config enum without
 * wiring it up is a compile error.
 */
export function createChannel(config: Config, logger: Logger): NotificationChannel {
  const channelLogger = logger.child({ component: 'channel' });

  switch (config.NOTIFICATION_CHANNEL) {
    case 'console':
      return new ConsoleChannel(channelLogger);
    case 'smtp':
      return new SmtpChannel(config, channelLogger);
    default: {
      const exhaustive: never = config.NOTIFICATION_CHANNEL;
      throw new Error(`Unsupported notification channel: ${String(exhaustive)}`);
    }
  }
}
