import MessageService, { IMessageServiceOptions } from './message_service';
import { IContext } from './context';
import { Logger } from './logger';

/**
 * RunnableService extends MessageService with lifecycle management.
 *
 * Provides:
 * - Convention-based ProtoFileName (derived from ServiceName)
 * - Graceful shutdown handling (SIGINT, SIGTERM)
 * - Static start() method for easy service bootstrap
 * - Optional cleanup hook for custom shutdown logic
 *
 * Usage:
 * ```typescript
 * class CalculatorService extends RunnableService implements Calculator.Service {
 *   ServiceName = Calculator.ServiceName;
 *
 *   async generateReport(request: Calculator.IGenerateReportRequest) {
 *     // Implementation
 *   }
 * }
 *
 * // Start the service
 * RunnableService.start(context, CalculatorService);
 * ```
 */
export default abstract class RunnableService extends MessageService {
    constructor(context: IContext, options: IMessageServiceOptions = {}) {
        super(context, options);
    }

    /**
     * Convention-based proto file resolution.
     * 'Calculator.Service' -> 'Calculator.proto'
     *
     * Override this if your proto files follow a different naming convention.
     */
    public get ProtoFileName(): string {
        const packageName = this.ServiceName.split('.')[0] || this.ServiceName;
        return `${packageName}.proto`;
    }

    /**
     * Optional cleanup hook called during shutdown.
     * Override this to add custom cleanup logic (close DB connections, etc.)
     */
    protected async cleanup(): Promise<void> {
        // Default: no-op. Override in subclass if needed.
    }

    /**
     * Start a service with automatic signal handling and graceful shutdown.
     *
     * @param context - The protobus Context instance
     * @param ServiceClass - The service class to instantiate
     * @param options - Optional service options (maxConcurrent, retry)
     * @param postInit - Optional callback after service initialization
     */
    static async start<T extends RunnableService>(
        context: IContext,
        ServiceClass: new (context: IContext, options?: IMessageServiceOptions) => T,
        options?: IMessageServiceOptions,
        postInit?: (service: T) => Promise<void>
    ): Promise<T> {
        let service: T | null = null;
        let shuttingDown = false;

        /**
         * @param exitCode - 0 for a signal-initiated shutdown, non-zero when we
         *   are bailing out of a failed startup. Exiting 0 on a startup failure
         *   told Kubernetes and systemd the process had succeeded, so a service
         *   that could not start was never restarted.
         */
        const shutdown = async (signal?: string, exitCode: number = 0) => {
            if (shuttingDown) { return; }
            shuttingDown = true;
            Logger.info(`Shutdown initiated${signal ? ` (signal: ${signal})` : ''}`);

            // 1. Stop taking new work, keeping channels open. The cleanup
            //    hook must not run while consumers are still delivering, or a
            //    request can arrive after the user has closed its resources.
            if (service) {
                try {
                    await service.stopConsuming();
                    Logger.info('Stopped accepting new messages');
                } catch (error) {
                    Logger.error(`Failed to stop consumers: ${error}`);
                }
            }

            // 2. Let work already in hand finish — including the reply, retry
            //    or DLQ publish that settles it — before anything is torn down.
            try {
                const budget = Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS) || 30000;
                const inFlight = context.connection.inFlightDeliveries;
                if (inFlight > 0) {
                    Logger.info(`Draining ${inFlight} in-flight message(s), up to ${budget}ms`);
                    const drained = await context.connection.drainInFlight(budget);
                    Logger.info(drained
                        ? 'In-flight messages drained'
                        : `Drain deadline reached with ${context.connection.inFlightDeliveries} still running; ` +
                          'they stay unacknowledged and will be redelivered');
                }
            } catch (error) {
                Logger.error(`Drain failed: ${error}`);
            }

            // 3. Only now is it safe to release the user's resources.
            if (service) {
                try {
                    await service.cleanup();
                    Logger.info('Service cleanup completed');
                } catch (error) {
                    Logger.error(`Service cleanup failed: ${error}`);
                }
            }

            try {
                await context.connection.disconnect();
                Logger.info('Connection closed');
            } catch (error) {
                Logger.error(`Connection close failed: ${error}`);
            }

            // 4. Set the status and let the event loop drain naturally, so
            //    pending stdout writes are not truncated. The bounded backstop
            //    still guarantees the process leaves if something else keeps
            //    the loop alive past the grace period.
            process.exitCode = exitCode;
            const grace = Number(process.env.SHUTDOWN_EXIT_GRACE_MS) || 5000;
            const backstop = setTimeout(() => {
                Logger.warn(`Event loop still active ${grace}ms after shutdown; forcing exit`);
                process.exit(exitCode);
            }, grace);
            if (backstop.unref) { backstop.unref(); }
        };

        // Setup signal handlers. `once`, not `on`: calling start() more than
        // once per process otherwise stacked duplicate handlers that each ran a
        // full shutdown.
        const onSigint = () => { void shutdown('SIGINT'); };
        const onSigterm = () => { void shutdown('SIGTERM'); };
        process.once('SIGINT', onSigint);
        process.once('SIGTERM', onSigterm);

        try {
            service = new ServiceClass(context, options);
            Logger.info(`Starting service: ${service.ServiceName}`);

            await service.init();

            if (postInit) {
                await postInit(service);
            }

            Logger.info(`Service ready: ${service.ServiceName}`);
            return service;

        } catch (error) {
            Logger.error(`Service startup failed: ${error}`);
            process.removeListener('SIGINT', onSigint);
            process.removeListener('SIGTERM', onSigterm);
            await shutdown(undefined, 1);
            throw error;
        }
    }
}
