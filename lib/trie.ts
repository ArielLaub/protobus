class TrieNode<T> {
    private word: string;
    private value: T;
    private children: Map<string, TrieNode<T>>;
    private isWildcard: boolean;
    private isSuperWildcard: boolean;

    public get Value(): T { return this.value; }

    constructor(word: string = '', value?: T) {
        this.children = new Map<string, TrieNode<T>>();
        this.word = word;
        this.value = value;
        this.isWildcard = word === '*' || word === '#'; // caching
        this.isSuperWildcard = word === '#'; // caching
    }

    private addMatchDeep(match: string, value?: T, _tail?: string[]): TrieNode<T> {
        const tail = _tail ? _tail : match.split('.');
        const word = tail.shift();
        const child = this.ensureChild(word, value);
        if (tail.length > 0)
            return child.addMatchDeep(match, value, tail);
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
            if (this.children.size === 0) {
                return [this];
            }

            if (this.children.has('#')) {
                const results2 = this.children.get('#').matchTopicDeep(topic, _tail, false);
                return results.concat(results2);
            } else {
                // only return word if this is a leaf. we only want full matches.
                return  results;
            }
        }


        this.children.forEach(processChild);
        if (this.isSuperWildcard) {
            processChild(this);
        }

        return results;
    }

    private ensureChild(word: string, value?: T): TrieNode<T> {
        if (this.children.has(word)) {
            return this.children.get(word);
        }

        const child = new TrieNode(word, value);
        this.children.set(word, child);
        // this.value = undefined;

        return child;
    }

    public addMatch(match: string, value: T): TrieNode<T> {
        return this.addMatchDeep(match, value);
    }

    public matchTopic(topic: string): T[] {
        const results = new Set<T>();
        const processChild = (child: TrieNode<T>) => {
            const result = child.matchTopicDeep(topic);
            result.forEach((node: TrieNode<T>) => {
                results.add(node.Value);
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