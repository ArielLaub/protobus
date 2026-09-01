import Trie from '../../lib/trie';

/**
 * The worked example in docs/message-flow.md, executed.
 *
 * It claimed `ORDERS.*.CREATED` matched `ORDERS.US.123.CREATED`. It does not —
 * `*` stands for exactly one word, so the pattern describes a three-word topic
 * and the event has four. The code was correct; only the documentation was wrong,
 * which is precisely the kind of error a reader trusts and a reviewer skims past.
 *
 * This test exists so the page cannot drift from the implementation again. If you
 * change these expectations, change the document to match.
 */
describe('the wildcard example in docs/message-flow.md', () => {
    const build = () => {
        const trie = new Trie<string>();
        trie.add('ORDERS.*.CREATED', 'A');
        trie.add('ORDERS.#', 'B');
        trie.add('ORDERS.US.*.SHIPPED', 'C');
        return trie;
    };

    it.each([
        ['ORDERS.US.CREATED',      ['A', 'B'], '* binds one word'],
        ['ORDERS.US.123.CREATED',  ['B'],      '* cannot cover two words'],
        ['ORDERS.US.123.SHIPPED',  ['B', 'C'], 'a literal segment plus *'],
        ['ORDERS.EU.456.SHIPPED',  ['B'],      'the literal US does not match EU'],
    ])('%s → %p (%s)', (event, expected) => {
        expect(build().match(event as string).sort()).toEqual(expected);
    });

    it('# matches the bare root, where * does not', () => {
        expect(build().match('ORDERS')).toEqual(['B']);
    });
});
