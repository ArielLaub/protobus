/**
 * The broker the integration suite runs against.
 *
 * Every file used to hardcode `localhost:5672`. On a machine that also runs a
 * `kubectl port-forward` to a cluster broker, that forward binds
 * 127.0.0.1:5672 and shadows the docker-compose broker, so `localhost` reached
 * a shared, busy broker instead of the one `docker compose up` started (#36).
 * Set these to pin a run to a known broker; the defaults are the
 * docker-compose ones.
 *
 *   PROTOBUS_TEST_AMQP_URL   amqp://guest:guest@localhost:5672/
 *   PROTOBUS_TEST_MGMT_URL   http://guest:guest@localhost:15672
 *
 * (The same variables protobus-go's suites read. RABBITMQ_MGMT is still
 * honoured for the management URL.)
 */
export const AMQP_URL = process.env.PROTOBUS_TEST_AMQP_URL || 'amqp://guest:guest@localhost:5672/';

export const MGMT_URL = process.env.PROTOBUS_TEST_MGMT_URL
    || process.env.RABBITMQ_MGMT
    || 'http://guest:guest@localhost:15672';

/** AMQP_URL with its vhost replaced, for tests that need a vhost of their own. */
export function amqpUrlForVhost(vhost: string): string {
    const u = new URL(AMQP_URL);
    u.pathname = '/' + encodeURIComponent(vhost);
    return u.toString();
}
