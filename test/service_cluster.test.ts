import * as request from 'supertest';
import * as express from 'express';
import { expect } from 'chai';
import { SimpleService, SimpleService2 } from './helpers/simple_service';
import Context from '../lib/context';
import ServiceProxy from '../lib/service_proxy';
import ServiceCluster from '../lib/service_cluster';
import { Logger } from '../lib/logger';

const AMQP_CONNECTION_STRING = 'amqp://guest:guest@localhost:5672/';

describe('ServiceCluster tests suite', () => {
    let client: any;
    let client2: any;
    let cluster: ServiceCluster;
    before(async () => {
        try {
            const context = new Context();
            await context.init(AMQP_CONNECTION_STRING, []);

            cluster = new ServiceCluster(context);
            cluster.use(SimpleService, '/first');
            cluster.use(SimpleService2, '/second');
            await cluster.init();
            const serviceNames = cluster.ServiceNames;
            expect(serviceNames).to.have.property('length', 2);
            expect(serviceNames).to.contain('Simple1.Service');
            expect(serviceNames).to.contain('Simple2.Service');

            client = new ServiceProxy(context, 'Simple1.Service');
            await client.init();
            client2 = new ServiceProxy(context, 'Simple2.Service');
            await client2.init();
        }
        catch (error) {
            console.error(error);
        }
    });

    it('should test an RPC call', async () => {
        const res = await client.simpleMethod({ num1: 1, num2: 2});
        expect(res).to.have.property('result', 3);
        const res2 = await client2.simpleMethod({ num1: 1, num2: 2});
        expect(res2).to.have.property('result', 2);
    });

    it('should test sub express ap routing', async () => {
        const app = await cluster.routeHttp();
        const res = await request(app).get('/first/simpleMethod?num1=1&num2=2');
        expect(res).to.have.property('status', 200);
        expect(res.body).to.have.property('result', 3);
        const res2 = await request(app).get('/second/simpleMethod?num1=1&num2=2');
        expect(res2).to.have.property('status', 200);
        expect(res2.body).to.have.property('result', 2);
    });
});

