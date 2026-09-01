import { IContext, MessageService } from 'protobus';

const STAMP = `T${Date.now()}`;

function protoFor(pkg: string): string {
    return `syntax = "proto3";
package ${pkg};

message Request  { string tag = 1; }
message Response { string tag = 1; }

service Service {
    rpc handle(${pkg}.Request) returns(${pkg}.Response);
}`;
}

export class RecordingService extends MessageService {
    public handled: string[] = [];

    constructor(context: IContext, private pkg: string = STAMP) {
        super(context, { maxConcurrent: 1, retry: { maxRetries: 0 } });
    }

    get ServiceName() { return `${this.pkg}.Service`; }
    get ProtoFileName() { return ''; }
    get Proto() { return protoFor(this.pkg); }

    async handle(request: { tag: string }) {
        this.handled.push(request.tag);
        return { tag: request.tag };
    }
}
