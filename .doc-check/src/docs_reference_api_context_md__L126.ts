import { IContext } from 'protobus';

async function callPlayer(
    context: IContext, targetPlayerId: string, method: string, data: any,
) {
    // Encoding uses the CONTRACT name, which is what the .proto declares.
    const buffer = context.factory.buildRequest(`Combat.Player.${method}`, data, 'referee');

    // Routing uses the INSTANCE name, which is what the service bound.
    const routingKey = `REQUEST.Combat.Player.${targetPlayerId}.${method}`;

    const responseData = await context.publishMessage(buffer, routingKey, true);
    const response = context.factory.decodeResponse(responseData);

    if (response.error) {
        throw new Error(response.error.message);
    }
    return response.result.data as any;
}
