import { IContext, ServiceProxy } from 'protobus';

async function connect(context: IContext) {
    const assistant: any = new ServiceProxy(context, 'Chat.Assistant');
    await assistant.init();
    return assistant;
}
