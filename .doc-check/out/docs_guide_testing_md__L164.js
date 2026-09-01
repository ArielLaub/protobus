"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RecordingService = void 0;
const protobus_1 = require("protobus");
const STAMP = `T${Date.now()}`;
function protoFor(pkg) {
    return `syntax = "proto3";
package ${pkg};

message Request  { string tag = 1; }
message Response { string tag = 1; }

service Service {
    rpc handle(${pkg}.Request) returns(${pkg}.Response);
}`;
}
class RecordingService extends protobus_1.MessageService {
    pkg;
    handled = [];
    constructor(context, pkg = STAMP) {
        super(context, { maxConcurrent: 1, retry: { maxRetries: 0 } });
        this.pkg = pkg;
    }
    get ServiceName() { return `${this.pkg}.Service`; }
    get ProtoFileName() { return ''; }
    get Proto() { return protoFor(this.pkg); }
    async handle(request) {
        this.handled.push(request.tag);
        return { tag: request.tag };
    }
}
exports.RecordingService = RecordingService;
