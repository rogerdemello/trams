import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  jetstreamManager,
  type JetStreamManager,
} from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';
import type { NatsConnection } from '@nats-io/transport-node';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import {
  DEDUPE_WINDOW_NANOS,
  DLQ_SUBJECT_WILDCARD,
  STREAM_USER_EVENTS,
  STREAM_USER_EVENTS_DLQ,
  USER_SUBJECT_WILDCARD,
} from '../events/subjects.js';

/**
 * Stream and consumer topology, declared in code and applied idempotently at
 * startup.
 *
 * Why in code rather than a provisioning script: the stream configuration *is*
 * the delivery guarantee. `max_deliver`, `ack_wait` and the dedupe window
 * decide whether messages can be lost or duplicated, so they belong next to the
 * code that relies on them and must be version-controlled with it. A topology
 * applied by hand is one a new environment will get subtly wrong.
 *
 * Every operation here is safe to run repeatedly — services race to call this
 * on boot, and a redeploy must not disturb an existing stream.
 */

export async function createJetStreamManager(
  connection: NatsConnection,
): Promise<JetStreamManager> {
  return jetstreamManager(connection);
}

/**
 * Create or update both streams.
 *
 * Only the User Service runs this. The Notification Service has no permission
 * to manage streams, which is intentional: a consumer that can reconfigure the
 * stream it reads from can also delete the evidence of what it failed to process.
 */
export async function ensureStreams(jsm: JetStreamManager, logger: Logger): Promise<void> {
  await ensureStream(jsm, logger, {
    name: STREAM_USER_EVENTS,
    subjects: [USER_SUBJECT_WILDCARD],

    // File storage, not memory. Events must survive a broker restart —
    // in-memory storage would make the transactional outbox pointless, since
    // we would have carefully guaranteed the publish only to lose it later.
    storage: StorageType.File,

    // Limits retention (not WorkQueue) so the stream keeps messages after a
    // consumer acks them. This allows a second consumer to be added later and
    // replay history, and leaves an audit trail for debugging.
    retention: RetentionPolicy.Limits,
    max_age: nanos(7 * 24 * 60 * 60 * 1_000), // 7 days
    max_msgs: 1_000_000,
    max_bytes: 512 * 1024 * 1024,

    // Refuse new writes rather than silently discarding old messages when
    // full. A publish error surfaces as a retryable outbox failure; silent
    // discard would lose events with nothing to show for it.
    discard: DiscardPolicy.New,

    duplicate_window: DEDUPE_WINDOW_NANOS,
    num_replicas: 1, // single-node local broker; raise to 3 in a cluster
  });

  await ensureStream(jsm, logger, {
    name: STREAM_USER_EVENTS_DLQ,
    subjects: [DLQ_SUBJECT_WILDCARD],
    storage: StorageType.File,
    retention: RetentionPolicy.Limits,
    // Dead letters are kept far longer than live events: they exist to be
    // investigated by a human, who may not look until next week.
    max_age: nanos(30 * 24 * 60 * 60 * 1_000), // 30 days
    max_msgs: 100_000,
    discard: DiscardPolicy.Old,
    num_replicas: 1,
  });
}

interface StreamSpec {
  name: string;
  subjects: string[];
  storage: StorageType;
  retention: RetentionPolicy;
  max_age: number;
  max_msgs: number;
  max_bytes?: number;
  discard: DiscardPolicy;
  duplicate_window?: number;
  num_replicas: number;
}

async function ensureStream(
  jsm: JetStreamManager,
  logger: Logger,
  spec: StreamSpec,
): Promise<void> {
  try {
    await jsm.streams.info(spec.name);
    // Already exists: update so config changes in this file take effect on
    // redeploy, instead of leaving the stream frozen at whatever it was created
    // with months ago.
    await jsm.streams.update(spec.name, spec);
    logger.info({ stream: spec.name }, 'JetStream stream updated');
  } catch (error) {
    if (isStreamNotFound(error)) {
      await jsm.streams.add(spec);
      logger.info({ stream: spec.name, subjects: spec.subjects }, 'JetStream stream created');
      return;
    }
    throw error;
  }
}

export interface ConsumerSpec {
  stream: string;
  durableName: string;
  filterSubject: string;
  ackWaitMs: number;
  maxDeliver: number;
  maxAckPending: number;
}

/**
 * Create or update the durable pull consumer.
 *
 * Each setting maps to a specific failure mode:
 *
 *  durable_name    The consumer's position survives a restart. An ephemeral
 *                  consumer would silently re-process (or skip) everything
 *                  after a deploy.
 *
 *  ack_policy      Explicit. The broker only considers a message handled once
 *                  the worker says so, which is what makes redelivery on crash
 *                  possible at all.
 *
 *  deliver_policy  All. A newly deployed consumer processes the backlog rather
 *                  than skipping whatever accumulated while it was down.
 *
 *  ack_wait        How long the broker waits before assuming the worker died.
 *                  Too low and slow-but-healthy work gets duplicated; too high
 *                  and a genuine crash stalls that message for that long.
 *
 *  max_deliver     The cap that turns an infinite poison-message retry loop
 *                  into a finite one ending in the dead-letter queue.
 *
 *  max_ack_pending Backpressure. Bounds how much unacked work the broker will
 *                  hand out, so a burst cannot exhaust worker memory.
 */
export async function ensureConsumer(
  jsm: JetStreamManager,
  logger: Logger,
  spec: ConsumerSpec,
): Promise<void> {
  const config = {
    durable_name: spec.durableName,
    name: spec.durableName,
    filter_subject: spec.filterSubject,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    ack_wait: nanos(spec.ackWaitMs),
    max_deliver: spec.maxDeliver,
    max_ack_pending: spec.maxAckPending,
  };

  try {
    await jsm.consumers.info(spec.stream, spec.durableName);
    await jsm.consumers.update(spec.stream, spec.durableName, config);
    logger.info({ consumer: spec.durableName, stream: spec.stream }, 'JetStream consumer updated');
  } catch (error) {
    if (isConsumerNotFound(error)) {
      await jsm.consumers.add(spec.stream, config);
      logger.info(
        { consumer: spec.durableName, stream: spec.stream, filter: spec.filterSubject },
        'JetStream consumer created',
      );
      return;
    }
    throw error;
  }
}

/**
 * The JetStream API reports "not found" as an error with a numeric code rather
 * than a distinct type, so these helpers keep the string/code matching in one
 * place instead of scattering brittle checks across the codebase.
 */
function isStreamNotFound(error: unknown): boolean {
  return matchesJetStreamCode(error, [10059]) || /stream not found/i.test(errorMessage(error));
}

function isConsumerNotFound(error: unknown): boolean {
  return matchesJetStreamCode(error, [10014]) || /consumer not found/i.test(errorMessage(error));
}

function matchesJetStreamCode(error: unknown, codes: number[]): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = (error as { api_error?: { err_code?: number }; code?: number }).api_error
    ?.err_code;
  return typeof candidate === 'number' && codes.includes(candidate);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Configuration for the notification consumer, derived from validated config. */
export function notificationConsumerSpec(config: Config): ConsumerSpec {
  return {
    stream: STREAM_USER_EVENTS,
    durableName: config.NOTIFICATION_CONSUMER_NAME,
    filterSubject: USER_SUBJECT_WILDCARD,
    ackWaitMs: config.NOTIFICATION_ACK_WAIT_MS,
    maxDeliver: config.NOTIFICATION_MAX_DELIVER,
    maxAckPending: config.NOTIFICATION_MAX_ACK_PENDING,
  };
}
