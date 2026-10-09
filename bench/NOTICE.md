# Third-party corpora used by the bench

No corpus is redistributed in this repository. Each is fetched on demand
into a gitignored cache and identified by checksum. The licences below
permit redistribution; we decline it for size, not for law.

## LongMemEval

MIT licence. Used by the `lme-s-questions` arm
(`longmemeval_s_cleaned.json`).

- Code: <https://github.com/xiaowu0162/LongMemEval>
- Data: <https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned>

The haystack's filler sessions are sourced from ShareGPT and UltraChat;
the assembled dataset is published under MIT by its authors.

```bibtex
@article{wu2024longmemeval,
  title={LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory},
  author={Wu, Di and Wang, Hongwei and Yu, Wenhao and Zhang, Yuwei and Chang, Kai-Wei and Yu, Dong},
  year={2024}
}
```

Accepted at ICLR 2025.

## LongMemEval-V2

Apache License 2.0. For the planned `lme-v2-goals` arm — multimodal
web-agent trajectory memory (arXiv 2605.12493).

- Data: <https://huggingface.co/datasets/xiaowu0162/longmemeval-v2>

Where that arm derives its own gold labels (a trajectory's `goal` as the
query, the trajectory itself as the answer), those labels are ours and the
derivation is documented in the arm. They are not part of the published
benchmark and should not be cited as such.
