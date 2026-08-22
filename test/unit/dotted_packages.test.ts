import MessageFactory from '../../lib/message_factory';

const DOTTED = `
syntax = "proto3";
package com.example.billing;
service Calculator {
  rpc add(AddRequest) returns (AddResponse);
  rpc addStream(AddRequest) returns (stream AddResponse);
}
message AddRequest { int32 a = 1; int32 b = 2; }
message AddResponse { int32 result = 1; }
`;

describe('multi-segment protobuf packages', () => {
    let factory: MessageFactory;
    const FULL = 'com.example.billing.Calculator.add';

    beforeEach(() => {
        factory = new MessageFactory();
        factory.init([]);
        factory.parse(DOTTED, 'com.example.billing.Calculator');
    });

    it('builds and decodes a request', () => {
        const buf = factory.buildRequest(FULL, { a: 2, b: 3 }, 'tester');
        const decoded = factory.decodeRequest(buf);
        expect(decoded.method).toBe(FULL);
        expect(decoded.data).toMatchObject({ a: 2, b: 3 });
    });

    it('builds and decodes a response', () => {
        const buf = factory.buildResponse(FULL, { result: 5 });
        expect(factory.decodeResponse(buf).result!.data).toMatchObject({ result: 5 });
    });

    it('detects a streaming method', () => {
        expect(factory.isStreamingMethod('com.example.billing.Calculator.addStream')).toBe(true);
        expect(factory.isStreamingMethod(FULL)).toBe(false);
    });

    it('names the method, not the parse, when one does not exist', () => {
        expect(() => factory.buildRequest('com.example.billing.Calculator.nope', {}, 'x'))
            .toThrow(/nope/);
    });
});
