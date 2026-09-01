import { setLogger, setLogLevel, LogLevel, ILogger } from 'protobus';

const silent: ILogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export function quietProtobus(): void {
    setLogger(silent);
    setLogLevel(LogLevel.Silent);
}
