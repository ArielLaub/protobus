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

        const shutdown = async (signal?: string) => {
            Logger.info(`Shutdown initiated${signal ? ` (signal: ${signal})` : ''}`);

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

            process.exit(0);
        };

        // Setup signal handlers
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

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
            await shutdown();
            throw error;
        }
    }
}
