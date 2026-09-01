import { setLogLevel, getLogLevel, LogLevel } from 'protobus';

setLogLevel(LogLevel.Debug);
console.log(getLogLevel() === LogLevel.Debug);
