import Trie from '../../lib/trie';

describe('Trie tests suite', () => {
    it('should test exact simple match', () => {
        const trie = new Trie();
        trie.add('a.b.c', 'abc');
        trie.add('b.c.d', 2);

        let matches = trie.match('a.b.c');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toBe('abc');
        matches = trie.match('b.c.d');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toBe(2);
        matches = trie.match('c.d.e');
        expect(matches).toHaveLength(0);
    });

    it('should test a node split', () => {
        // both matches share the same first node
        const trie = new Trie();
        trie.add('a.b.c.2', 2);
        trie.add('a.b.c.1', 1);

        let matches = trie.match('a.b.c.1');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toBe(1);
        matches = trie.match('a.b.c.2');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toBe(2);
    });

    it('should not return a match if not a leaf', () => {
        // both matches share the same first node
        const trie = new Trie();
        trie.add('a.b.c.d', 'something');

        let matches = trie.match('a');
        expect(matches).toHaveLength(0);
        matches = trie.match('a.b');
        expect(matches).toHaveLength(0);
        matches = trie.match('a.b.c');
        expect(matches).toHaveLength(0);
        matches = trie.match('a.b.c.d');
        expect(matches).toHaveLength(1);
    });

    it('should test * wildcard in all positions', () => {
        const trie = new Trie();
        trie.add('*.b.c', 'first');
        trie.add('a.*.c', 'second');
        trie.add('a.b.*', 'third');
        let matches = trie.match('a.b.c');
        expect(matches).toHaveLength(3);
        expect(matches).toContain('first');
        expect(matches).toContain('second');
        expect(matches).toContain('third');
        matches = trie.match('z.b.c');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toBe('first');
        matches = trie.match('a.z.c');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toBe('second');
        matches = trie.match('a.b.z');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toBe('third');
    });

    it('should test # super wildcard replacing 0 or more words', () => {
        const trie = new Trie();
        trie.add('#.b.c', 'first');
        trie.add('a.#.c', 'second');
        trie.add('a.b.#', 'third');

        let matches = trie.match('z.b.c');
        expect(matches).toHaveLength(1);
        expect(matches).toContain('first');
        matches = trie.match('x.z.b.c');
        expect(matches).toHaveLength(1);
        expect(matches).toContain('first');
        matches = trie.match('x.y.z.b.c');
        expect(matches).toHaveLength(1);
        expect(matches).toContain('first');
        matches = trie.match('b.c');
        expect(matches).toHaveLength(1);
        expect(matches).toContain('first');
        matches = trie.match('b.b.b');
        expect(matches).toHaveLength(0);
        matches = trie.match('c.c.c');
        expect(matches).toHaveLength(0);

        matches = trie.match('a.z.c');
        expect(matches).toHaveLength(1);
        expect(matches).toContain('second');
        matches = trie.match('a.x.z.c');
        expect(matches).toHaveLength(1);
        expect(matches).toContain('second');
        matches = trie.match('a.x.y.z.c');
        expect(matches).toHaveLength(1);
        expect(matches).toContain('second');
        matches = trie.match('a.c');
        expect(matches).toHaveLength(1);
        expect(matches).toContain('second');
        matches = trie.match('a.a.a');
        expect(matches).toHaveLength(0);
        matches = trie.match('c.c.c');
        expect(matches).toHaveLength(0);

        matches = trie.match('a.b.z');
        expect(matches).toHaveLength(1);
        expect(matches).toContain('third');
        matches = trie.match('a.b.x.z');
        expect(matches).toHaveLength(1);
        expect(matches).toContain('third');
        matches = trie.match('a.b.x.y.z');
        expect(matches).toHaveLength(1);
        expect(matches).toContain('third');
        matches = trie.match('a.b');
        expect(matches).toHaveLength(1);
        expect(matches).toContain('third');
        matches = trie.match('a.a.a');
        expect(matches).toHaveLength(0);
        matches = trie.match('b.b.b');
        expect(matches).toHaveLength(0);

    });

    it('should verify test cases from rabbit blog post', () => {
        // https://www.rabbitmq.com/blog/2010/09/14/very-fast-and-scalable-topic-routing-part-1/

        const trie = new Trie();
        trie.add('a.b.c', 'first');
        trie.add('a.*.b.c', 'second');
        trie.add('a.#.c', 'third');
        trie.add('b.b.c', 'forth');

        const matches = trie.match('a.d.d.d.c');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toBe('third');
    });

    it('should verify test cases from RabbitMQ topics tutorial', () => {
        /*
            In this example, we're going to send messages which all describe animals.
            The messages will be sent with a routing key that consists of three words
            (two dots). The first word in the routing key will describe speed, second
            a colour and third a species: "<speed>.<colour>.<species>".
            We created three bindings: Q1 is bound with binding key "*.orange.*" and Q2
            with "*.*.rabbit" and "lazy.#".
            These bindings can be summarised as:
                - Q1 is interested in all the orange animals.
                - Q2 wants to hear everything about rabbits,
                  and everything about lazy animals.
        */
        const trie = new Trie();
        trie.add('*.orange.*', 'Q1');
        trie.add('*.*.rabbit', 'Q2');
        trie.add('lazy.#', 'Q2');

        // A message with a routing key set to "quick.orange.rabbit" will be delivered to both queues
        let matches = trie.match('quick.orange.rabbit');
        expect(matches).toHaveLength(2);

        // Message "lazy.orange.elephant" also will go to both of them
        matches = trie.match('lazy.orange.elephant');
        expect(matches).toHaveLength(2);
        // On the other hand "quick.orange.fox" will only go to the first queue
        matches = trie.match('quick.orange.fox');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toBe('Q1');
        // and "lazy.brown.fox" only to the second
        matches = trie.match('lazy.brown.fox');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toBe('Q2');
        //  "lazy.pink.rabbit" will be delivered to the second queue only once, even though it matches two bindings
        matches = trie.match('lazy.pink.rabbit');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toBe('Q2');

        // What happens if we break our contract and send a message with one or four words, like "orange"
        // or "quick.orange.male.rabbit"? Well, these messages won't match any bindings and will be lost.
        matches = trie.match('orange');
        expect(matches).toHaveLength(0);
        matches = trie.match('quick.brown.fox');
        expect(matches).toHaveLength(0);


        // On the other hand "lazy.orange.male.rabbit", even though it has four words,
        // will match the last binding and will be delivered to the second queue.
        matches = trie.match('lazy.orange.male.rabbit');
        expect(matches).toHaveLength(1);
        expect(matches[0]).toBe('Q2');
    });
});
