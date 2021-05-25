## Overview

ProtoBus is a lean, mean and super scalable micro-services message bus written entirely in TypeScript.

It is using RabbitMQ for routing and load balancing messages across different services.

We also implemented what we feel is a simple and easy to use abstraction layer to rapidly develop new micro services from scratch with an intuitive class inheritance model.

As a transport protocol we are using Google's Protobuf. This ensures messages are sent in a compact binary stream with a very fast serialization process. It also as a byproduct adds a type schema to any message sent on the bus.

These two underlying technologies ensure we'll have the ability to extend our platform and have services written in different languages as both AMQP and Protobuf are available for a wide range of programming languages.

## Prerequisites & Dependencies

This module is intended to be used in a high volume financial environment and as such we tried to choose battle tested components and as few dependencies as possible.

ProtoBus is based on AMQP so you'll need to install either RabbitMQ or use a cloud AMQP provider (Amazon MQ, CloudAMQP, etc).

As you can see for yourself from the package.json file we really kept the dependencies to a minimum with the few we did use being high profile and very popular. This termendously reduces the risk involved with foreign code in such a low level component.

## Installation

You can either clone this repo for the latest and greatest or download the official npm:
```
npm install protobus --save
``` 
or
```
yarn add protobus --save
```

## Main Components

We'll go over the main components of this library but in general a good rule of thumb would be to check the tests relevant to each component. It's easiest to understand how these different component work through real example. Overall there are just a handful of classes you need to deal with and most are one off setups.

### Context
A context basically exposes everything you need in order to communicate with services over the bus. It contains an AMQP connection to the bus, a message factory responsible for serialization of proto messages across the bus and finally APIs for dispatching RPC calls to remote services and firing events on the bus for others to consume.

The context constructor receives two parameter. The first being amqp connection string the bus is running on and the second being a list of directories containing .proto (protobuf) files that will be loaded and accessible to all services initiated in this context.

here is an example of creating and initializing a context object:
```ts
import { IContext, Context } from 'remarkable-bus';

const createContext = async () => {
    const AMQP_CONNECTION_STRING = 'amqp://guest:guest@localhost:5672/';
    const PROTO_LOCATIONS = [__dirname + './proto/'];
    const context = new Context();
    await context.init(AMQP_CONNECTION_STRING, PROTO_LOCATIONS);
    return context;
};
```
Protobuf files define schema/interface of the different services running on the bus.
it's important you understand and know protobuf in order to define services easily.
We recommend you familiarize youself with protobuf on Google's official site:
https://developers.google.com/protocol-buffers/

It's important to note there is a special mechanism within services that allows you to define the .proto related to a certain service within the service itself. The proto files loaded by the context are meant to be higher level shared packages.

We usually use a single .proto file per micro-service but that's up to you. Here is a simple proto file example:

```protobuf
syntax = "proto3";
package Simple;

message Request {
    int32 num1 = 1;
    int32 num2 = 2;
}

message Response {
    int32 result = 1;
}

message Event {
    string description = 1;
}

message MultiEvent {
    int32 count = 1;
}

service Service {
    rpc simpleMethod(Simple.Request) returns(Simple.Response);
}
```
This file defines a service called Simple.Service (we use a `<package name>.<service name>` notation to uniquely identify services across the system).
It defines one RPC method and the input and output types. It also defines two events this service might fire.
You'll need to define the services you want to use with this context in .proto files and supply the locations to the context constructor so it can resolve them.

### MessageService

A MessageService is the base class you need to inherit in order to implement a micro service on the bus. It also must have the interface defined in a .proto file, and this file also must be loaded into the context used to initiate the service.
here is an implementation for the .proto file we presented above:
```ts
import { IContext, Context, IMessageService, MessageService } from 'remarkable-bus';

class SimpleService extends MessageService {
    constructor(context: IContext) {
        super(context);
        console.log('simple service initialized');
    }

    public get ServiceName(): string { return 'Simple.Service'; }
    public get ProtoFileName(): string { return __dirname + '/service.proto' }
 
    async simpleMethod(request: any): Promise<any> {
        if (!request.num1 || !request.num2)
            throw new Error('invalid_params');

        return {
            result: request.num1 + request.num2
        };
    }
}

...

createContext.then(async (context: IContext) => {
    const service = new SimpleService(context);
    await service.init();
    console.log('service started');
});
```

### ServiceCluster

In many cases it makes sense to initiate a group of services together sharing the same process and the same context.
The ServiceCluster class does exactly that. It's basically a glorified services container with some fancy typescript magic. using ServiceCluster you can initialize services in a more compact way (if you have more than a few...) while enabling you to initialized 1 or more listeners per service:
```ts
import { ServiceCluster } from 'protobus';

...

const cluster = new ServiceCluster(context);
cluster.use(FullService, 2);
cluster.use(ExcellentService, 4);
cluster.use(BadService, 1);
cluster.use(RoomService, 2);
cluster.use(TaxiService, 2);
await cluster.init();
```

### ServiceProxy

Once you have a running message service instance you'll need a proxy to interact with it. ServiceProxy provides a dynamically generated interface based on the service name you load. Again it's important that the provided Context object will have the relevant .proto definitions for the needed service.

Here is an example of creating a ServiceProxy to interact with our SimpleService:
```ts
import { IContext, Context, ServiceProxy } from 'remarkable-bus';

...

createContext.then(async (context: IContext) => {
    const client = new ServiceProxy(context, 'Simple.Service');
    try {
        await client.init(); 
        const response = await client.simpleMethod({ num1: 1, num2: 2 }); 
        console.log(`got result ${response.result} from service`);
    } catch (error) {
        console.error('got error from service');
        console.error(error);
    }
});
```

protobus also supports an easy way to generate hard typed proxies. Based on a .proto file you can generate a typescript interface based proxy with all the added benefits like code completion and compilation level validations.

## Advanced Topics

### Events
You can easily implement pub/sub features using events. We support several event types:

#### Simple events with a static topic
In the following example a service is subscribing for its own event
```
const handler = async (event): Promise<any> => {
    expect(event).to.have.property('message', 'hello');
    resolve(undefined);
};
await subService.subscribeEvent('Simple.Event', handler);
await pubService.publishEvent('Simple.Event', { message: 'hello' });
```

#### Wildcard Events - events with a wildcard topic
In the following example we demonstrate the usage of wilcards.
```
const handler = async (event): Promise<any> => {
    console.log(event.count);
};
await subService.subscribeEvent('Simple.MultiEvent', handler, 'CUSTOM.*.TOPIC');
await pubService.publishEvent('Simple.MultiEvent', { count: 1 }, 'CUSTOM.1.TOPIC');
await pubService.publishEvent('Simple.MultiEvent', { count: 2 }, 'CUSTOM.2.TOPIC');
```

#### Persistent Events
Events in protobus are persisted until process successfully. This means that if a listener subscribes for a certain topic and got an event message, this message will be marked for deletion if and only if it was processed successfully (no errors) by the handler function. until they it remains in an 'unacked' state and will be re-delivered once the subscribing process recovers.

### Logger
We mentioned in the preface our aim to have as few dependencies as we can reasonably have within our limitations. This module will use the default console object for logging but you can easily integrate your own logger by implementing our ILogger interface and supplying an instance. Here is an example:
```ts
import { ILogger, setLogger } from 'remarkable-bus';

const emotionalLogger: ILogger = {
    info: (message) => { console.log(':) ' + message); },
    debug: (message) => { console.debug(';) ' + message); },
    warn: (message) => { console.warn(':\ ' + message); },
    error: (message) => { console.error(':( ' + message); )}
};
setLogger(emotionalLogger);
```

### Http routing (experimental)
It's a very common use case to tunnel http requests to rpc methods in different services. In order to keep all the service related code encapulated we introduced a routeHttp() method to both MessageService and ServiceCluster. In addition ServiceCluster.use() accepts a second parameter which is the base http path for that service.
routeHttp() returns an express app and the ServiceCluster groups all bound services as sub apps with the appropriate paths set when calling 'use'.
The basic idea is for the cluster to host the main app and within it create sub apps under the configured paths.

We'll add an example soon when the API is finalized.

## License

```
MIT License

Copyright (c) 2018 Remarkable Games Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

