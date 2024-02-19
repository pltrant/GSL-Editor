import * as untypedSnippets from './gsl.json';

export interface GslSnippet {
    prefix: string
    body: string[]
    description: string
}

export const snippets = untypedSnippets as { [name: string]: GslSnippet }
