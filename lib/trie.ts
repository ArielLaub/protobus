class TrieNode<T> {
    private word: string;
    /**
     * Every value registered at this exact pattern.
     *
     * A list, not a single slot: two subscribers to one topic are ordinary,
     * and holding one value meant the second silently replaced nothing and
     * was dropped. Empty on a node that is only a step along the way to a
     * longer pattern, which is what keeps partial matches from matching.
     */
    private values: T[];
    private children: Map<string, TrieNode<T>>;
    private isWildcard: boolean;
    private isSuperWildcard: boolean;

    public get Values(): readonly T[] { return this.values; }

    constructor(word: string = '') {
        this.children = new Map<string, TrieNode<T>>();
        this.word = word;
        this.values = [];
        this.isWildcard = word === '*' || word === '#'; // caching
        this.isSuperWildcard = word === '#'; // caching
    }

    public addValue(value: T): void {
        this.values.push(value);
    }

    private addMatchDeep(match: string, _tail?: string[]): TrieNode<T> {
        const tail = _tail ? _tail : match.split('.');
        const word = tail.shift();
        const child = this.ensureChild(word);
        if (tail.length > 0)
            return child.addMatchDeep(match, tail);
        else
            return child;
    }

    private matchTopicDeep(topic: string, _tail?: string[], _reprocess?: boolean): TrieNode<T>[] {
        const tail = _tail ? Array.from(_tail) : topic.split('.');
        const results = [];
        const processChild = (child: TrieNode<T>) => {
            const reprocess = child === this;
            const result = child.matchTopicDeep(topic, tail, reprocess);
            result.forEach((node: TrieNode<T>) => { results.push(node); });
        };
        // allow for replacement of zero words as '#' can be replaced by zero or more.
        // we do this by propagating the call to all children before shifting the tail
        // reprocess is true only for super wildcards so that we don't double process
        if (this.isSuperWildcard && !_reprocess && this.children.size > 0) {
            this.children.forEach(processChild);
        }

        const word = tail.shift();
        if (!this.isWildcard && this.word !== word) {
            return results;
        }

        if (tail.length === 0) {
            // A pattern ends here if anything was registered on this node —
            // independently of whether longer patterns branch off it. Keying
            // this on "has no children" instead meant adding `a.b.c` silently
            // stopped `a.b` from matching.
            if (this.values.length > 0) {
                results.push(this);
            }

            // '#' stands for zero or more words, so a pattern ending in one
            // also ends here.
            if (this.children.has('#')) {
                return results.concat(this.children.get('#').matchTopicDeep(topic, _tail, false));
            }
            return results;
        }


        this.children.forEach(processChild);
        if (this.isSuperWildcard) {
            processChild(this);
        }

        return results;
    }

    private ensureChild(word: string): TrieNode<T> {
        if (this.children.has(word)) {
            return this.children.get(word);
        }

        const child = new TrieNode<T>(word);
        this.children.set(word, child);

        return child;
    }

    public addMatch(match: string, value: T): TrieNode<T> {
        // Only the node the pattern ends on carries the value. Marking every
        // node along the path made each one look like a registered pattern.
        const node = this.addMatchDeep(match);
        node.addValue(value);
        return node;
    }

    public matchTopic(topic: string): T[] {
        const results = new Set<T>();
        const processChild = (child: TrieNode<T>) => {
            const result = child.matchTopicDeep(topic);
            result.forEach((node: TrieNode<T>) => {
                node.Values.forEach((value) => results.add(value));
            });
        };
        this.children.forEach(processChild);
        return Array.from(results);
    }
}

export default class Trie<T> {
    private root: TrieNode<T>;

    constructor() {
        this.root = new TrieNode<T>();
    }

    public match(topic: string): T[] {
        return this.root.matchTopic(topic);
    }

    public add(match: string, value: T): void {
        this.root.addMatch(match, value);
    }
}