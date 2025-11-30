import { SimpleService, SimpleService2 } from './helpers/simple_service';
import Context from '../../lib/context';
import ServiceProxy from '../../lib/service_proxy';
import ServiceCluster from '../../lib/service_cluster';

const AMQP_CONNECTION_STRING = 'amqp://guest:guest@localhost:5672/';

describe('ServiceCluster tests suite', () => {
    let client: any;
    let client2: any;
    let cluster: ServiceCluster;
    let context: Context;

    beforeAll(async () => {
        context = new Context();
        await context.init(AMQP_CONNECTION_STRING, []);

        cluster = new ServiceCluster(context);
        cluster.use(SimpleService);
        cluster.use(SimpleService2);
        await cluster.init();
        const serviceNames = cluster.ServiceNames;
        expect(serviceNames).toHaveLength(2);
        expect(serviceNames).toContain('Simple1.Service');
        expect(serviceNames).toContain('Simple2.Service');

        client = new ServiceProxy(context, 'Simple1.Service');
        await client.init();
        client2 = new ServiceProxy(context, 'Simple2.Service');
        await client2.init();
    });

    afterAll(async () => {
        if (context && context.isConnected) {
            await context.connection.disconnect();
        }
    });

    it('should test an RPC call', async () => {
        const res = await client.simpleMethod({ num1: 1, num2: 2});
        expect(res).toHaveProperty('result', 3);
        const res2 = await client2.simpleMethod({ num1: 1, num2: 2});
        expect(res2).toHaveProperty('result', 2);
    });

    it('should initialize multiple service instances', async () => {
        // Create a new context to avoid proto conflicts
        const newContext = new Context();
        await newContext.init(AMQP_CONNECTION_STRING, []);

        const multiCluster = new ServiceCluster(newContext);
        multiCluster.use(SimpleService, 3);
        expect(multiCluster.ServiceNames).toHaveLength(3);
        expect(multiCluster.ServiceNames).toEqual(['Simple1.Service', 'Simple1.Service', 'Simple1.Service']);

        await newContext.connection.disconnect();
    });
});
