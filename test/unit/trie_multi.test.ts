import Trie from '../../lib/trie';

describe('Trie keeps every registered pattern', () => {
    it('keeps both handlers registered on the same topic', () => {
        const trie = new Trie<string>();
        trie.add('EVENT.Order', 'a');
        trie.add('EVENT.Order', 'b');
        expect(trie.match('EVENT.Order').sort()).toEqual(['a', 'b']);
    });

    it('keeps a pattern that a longer one is later added beneath', () => {
        const trie = new Trie<string>();
        trie.add('EVENT.Order', 'short');
        trie.add('EVENT.Order.Shipped', 'long');
        expect(trie.match('EVENT.Order')).toEqual(['short']);
        expect(trie.match('EVENT.Order.Shipped')).toEqual(['long']);
    });

    it('is insensitive to registration order', () => {
        const trie = new Trie<string>();
        trie.add('EVENT.Order.Shipped', 'long');
        trie.add('EVENT.Order', 'short');
        expect(trie.match('EVENT.Order')).toEqual(['short']);
        expect(trie.match('EVENT.Order.Shipped')).toEqual(['long']);
    });

    it('still matches only complete patterns', () => {
        const trie = new Trie<string>();
        trie.add('a.b.c.d', 'deep');
        expect(trie.match('a')).toHaveLength(0);
        expect(trie.match('a.b')).toHaveLength(0);
        expect(trie.match('a.b.c')).toHaveLength(0);
        expect(trie.match('a.b.c.d')).toEqual(['deep']);
    });

    it('keeps intermediate values out of unrelated matches', () => {
        const trie = new Trie<string>();
        trie.add('EVENT.Order', 'short');
        trie.add('EVENT.Order.Shipped', 'long');
        trie.add('EVENT.Invoice.Paid', 'other');
        expect(trie.match('EVENT.Invoice')).toHaveLength(0);
        expect(trie.match('EVENT.Invoice.Paid')).toEqual(['other']);
    });

    it('deduplicates one value reached through two patterns', () => {
        const trie = new Trie<string>();
        trie.add('*.*.rabbit', 'Q2');
        trie.add('lazy.#', 'Q2');
        expect(trie.match('lazy.pink.rabbit')).toEqual(['Q2']);
    });

    it('keeps several handlers under a wildcard', () => {
        const trie = new Trie<string>();
        trie.add('EVENT.*', 'x');
        trie.add('EVENT.*', 'y');
        trie.add('EVENT.Order', 'exact');
        expect(trie.match('EVENT.Order').sort()).toEqual(['exact', 'x', 'y']);
    });
});
