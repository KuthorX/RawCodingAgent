# wordfreq

Reads text from stdin and prints `word count`, one per line.

- Words are lowercase runs of letters a-z (everything else separates words).
- Default order: count descending; ties broken alphabetically.
- `--reverse`: count ascending; ties still alphabetical.
- `--top N`: print only the first N lines (after ordering). Can be combined with `--reverse`.
- Any other argument: print an error to stderr and exit with code 2.
