"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
async function callPlayer(context, targetPlayerId, method, data) {
    // Encoding uses the CONTRACT name, which is what the .proto declares.
    const buffer = context.factory.buildRequest(`Combat.Player.${method}`, data, 'referee');
    // Routing uses the INSTANCE name, which is what the service bound.
    const routingKey = `REQUEST.Combat.Player.${targetPlayerId}.${method}`;
    const responseData = await context.publishMessage(buffer, routingKey, true);
    const response = context.factory.decodeResponse(responseData);
    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.result.data;
}
