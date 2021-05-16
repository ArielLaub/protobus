export interface ILogger {
    info(message: any): void;
    warn(message: any): void;
    debug(message: any): void;
    error(message: any): void;
}

export class DefaultLogger implements ILogger {
    info(message: any) {
        console.log(message);
    }
    debug(message: any) {
        console.debug(message);
    }
    warn(message: any) {
        console.warn(message);
    }
    error(message: any) {
        console.error(message);
    }
}

export let Logger: ILogger = new DefaultLogger();

export function set(newLogger: ILogger) {
    Logger = newLogger;
}
