# Third-party notices

The `butterfly-effect` and `hide` skills were copied from the MIT-licensed
`monadrome/butterfly-effect-skill` and `monadrome/hiding-skill` projects. Their
frontmatter and references remain available in each skill directory. Omha
adds the orchestration CLI and new skill contracts around them; it does not
claim authorship of those upstream portions. Full MIT notices ship at
`skills/butterfly-effect/LICENSE` and `skills/hide/LICENSE`.

Sources: <https://github.com/monadrome/butterfly-effect-skill> (0.7.1) and
<https://github.com/monadrome/hiding-skill> (0.10.0). The retained contracts and
references are not rewritten by Omha's formatter. The Node runtime,
automatic evidence detector and five Omha-specific contracts are original
implementations; they do not perform a conversation rewind or reuse unlicensed
code from other workspace projects.

Runtime dependency `yaml` is ISC licensed; npm installs its upstream LICENSE
with the package. It parses structured Markdown frontmatter. `prettier` is an
MIT-licensed development-only formatting dependency and is excluded from the
runtime tarball.
