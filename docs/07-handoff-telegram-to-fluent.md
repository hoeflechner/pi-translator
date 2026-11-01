# Handoff — Telegramm-Stil bleibt, der Translator macht daraus flüssiges Deutsch

**Datum:** 2026-11-01 · **Auftraggeber:** Bernhard (Owner) · **Status:** offen, wartet auf Implementierung
**Vorgeschichte:** `llms/context-rot-language-decay.md` (Attributionsanalyse), Audit-Log `auditlog/` (421 Zeilen, 10.10.–01.11.)

## 1. Mission (Owner-Entscheidung, nicht verhandelbar)

Die **Session bleibt im Telegrammstil**. Knappheit spart Tokens; an AGENTS.md, ponytail oder
`workingGuideline()` wird **nichts** geändert. Auch die frühere Anregung „complete sentences als
Agent-Regel" ist damit hinfällig — Stil-Korrektur ist **alleinige Aufgabe der Formulierungsschicht**.

Der Formulierungs-Aufruf (`buildFormulatePrompt` in `pi-translator.ts`, ca. Zeile 228) muss die
Richtung umkehren: Der DRAFT ist bewusst notizartig (Fragmente, Nominalstil, keine Verben bei
Aufzählungen). Das ist erwünscht und keine zu „reparierende" Schwäche. Die Ausgabe soll daraus
**flüssig lesbaren, korrekten Text** machen: vollständige Sätze mit Subjekt und finitem Verb,
kurze Hauptsätze statt Verschachtelung, keine ins Deutsche übernommenen englischen Satzarchitekturen
(dangling appositions à la „…, mit X und Y", gestapelte Nominalkonstruktionen, Kalques).

## 2. Was gemessen ist (Ausgangslage, auditlog 10.10.–01.11., n=7002/3039 Sätze)

| Messgröße | DRAFT (EN) | geliefertes DE | Ziel nach Adaption |
|---|---|---|---|
| Wörter/Satz | 21,1 | **22,6** (wird länger!) | ≤ DRAFT-Niveau |
| Sätze ≥ 25 Wörter | 26,8 % | **32,0 %** (wird schlimmer!) | **sinkend**, Ziel ≤ 22 % |
| Fragmente ≤ 6 Wörter | 10,3 % | 7,2 % | **≤ 2 %** (Fragmente tilgen, nicht nur glätten) |
| ratio out/in (M5) | — | Median 1,00 / p90 1,09 | **≤ 1,10** (knapp halten, kein Füller) |

Der jetzige Prompt sagt „re-derive, keep every fact, add nothing" — aber nichts über Satzgröße,
Vollständigkeit oder Satzarchitektur. Genau diese drei Regler fehlen.

## 3. Konkrete Änderungen

### 3.1 `buildFormulatePrompt` — neue Bullets (Form, nicht Sprachpolitik)

Zu den bestehenden Bullets ergänzen (Formuliervorschlag, gern straffen):

```
- The DRAFT is terse working notes: fragments, noun phrases and verbless lines are EXPECTED, not errors. Your job is to turn every fragment into a complete sentence with a subject and a finite verb.
- Prefer short main clauses. Split any sentence longer than about 20 words into two.
- Do not copy the DRAFT's clause architecture into the target language: no dangling appendages ("…, with X and Y"-style tails), no stacked noun compounds. Write the way a careful native editor would.
- Terse stays terse: the answer must not grow beyond about 110% of the DRAFT's prose length.
```

Bestehendes bleibt unangetastet: Fakten-Treue, „add nothing", Sprachnamen-Header,
`PLACEHOLDER_RULE`, Markdown-Kodierung byte-identisch. **Keine Sprach-/Anredefassung (du/Sie,
No-Anglizismen u. ä.) in den Basis-Prompt hartkodieren** — Owner-Regel: Stilpolitik kommt nur
user-supplied über `promptAppend`.

### 3.2 `FORMULATE_REASONING` (Zeile ~420) als mitzubearbeitenden Regler verstehen

Der Kommentar dokumentiert es: level ist der Polishing-Knob; `low`/`medium` antworten schnell,
**kopieren** aber den DRAFT (noop-Signatur) statt ihn umzuschreiben. Nach 3.1 neu vermessen:
Wenn das neue Prompt-Regelwerk ein echtes Umformulieren erzwingt, prüfen, ob `low` dann
ausreicht (spart die 12k-Token-Reasoning-Läufe von xhigh). Messen über `verdict:"noop"`-Quote
pro Modelllabel im Gate, nicht raten.

### 3.3 Modell-Frage: Politik unverändert, Messung ergänzen

Die Owner-Entscheidung bleibt: Übersetzer = Agenten-Modell, Override über `model`-Setting /
`PI_TRANSLATOR_MODEL`. Nicht am Default drehen. Aber dem Audit-Gate eine Auswertung pro Modelllabel
geben; bekannt: `sharc/qwen3.8-flash-next` poliert 388/421 selbst (das geschädigte Modell poliert
sich selbst), `local/smart` ist als Polierer disqualifiziert (Reasoning-Überlauf → leerer Inhalt),
`fast` ist schnell und sauber (2,0–2,7 s, 0 CJK, getreu). Wenn das neue Prompt-Regelwerk steht, ist
ein Owner-Test mit `PI_TRANSLATOR_MODEL=fast` die natürliche nächste Entscheidung — seine Hand,
nicht die des Implementierers.

### 3.4 `scripts/audit-gate.mjs` — Stil-Metriken hinzufügen

Heute: M5 ratio (watch >1,5). Ergänzen für `dir=reply, verdict=text`:
**Wörter/Satz** (in vs. out), **≥25-Wort-Anteil** (in vs. out), **Fragment-Anteil ≤6 Wörter**
(in vs. out). Watch-Status, wenn out schlechter als in. Schwellen aus Tabelle §2. Die Spalten
`in`/`out` stehen im Audit-Log bereits zur Verfügung.

### 3.5 Replay-Harness (das entscheidende Werkzeug, offline)

Neues `scripts/replay.mjs`: liest das Audit-Log, nimmt `in` (DRAFT) + QUESTION der `dir=reply`-
Zeilen und fährt die Entwürfe offline **mit variantem Formulate-Prompt** neu durch denselben
Codepfad (`buildFormulatePrompt` → `translateWithRetry` mit Guards). Pro Variante die Metriken
aus 3.4 ausgeben. Damit wird der Prompt-Wechsel A/B-testbar, **ohne** das laufende System
anzufassen — und weil der Formulierungs-Call kontextfrei ist, ist das Replay exakt, nicht
näherungsweise. Mindest-Varianten: `current` (Referenz), `terse-fluent` (3.1),
`terse-fluent + reasoning:low`.

## 4. Tests

`pi-translator.test.ts` ergänzen: `buildFormulatePrompt` enthält die neuen Bullets und weiterhin
alle alten Zusagen (Header, Placeholder-Regel, Kodier-Zeile); `promptAppend` kann die neuen Bullets
nicht stumm entfernen. Hinweis: `test/sdkHost.test.ts` ist unter nacktem vitest nicht sammelbar
(typebox ist Host-Paket von Pi) — bekannt, kein Defekt, nicht fixen.

## 5. Verbotenes (ausdrücklich)

- Keine Änderungen an AGENTS.md, ponytail oder `workingGuideline()` — Sessions bleiben telegrammartig.
- Keine Sprach-/Stilpolitik im Code hartkodieren (§3.1) — nur `promptAppend`.
- Kein Default-Modellwechsel (§3.3).
- Keine Auto-Aktualisierung: Deployment bleibt manuell (Owner-Prinzip).

## 6. Deployment-Pfad (korrekt, in dieser Reihenfolge)

1. In `/data/bernhard/pi-translator` ändern, `vitest run` (mit bekannter sdkHost-Ausnahme grün).
2. **Commit und Push** auf `github.com/hoeflechner/pi-translator` (installiert wird das GIT-Paket aus
   `~/.pi/agent/git/github.com/hoeflechner/pi-translator` — der Checkout hier deployment-wirksam zu
   machen ist falsch).
3. Bernhard führt `pi update --extensions` **manuell** aus.
4. Wirkung erst nach **sessiond-Neustart** (laufender sessiond behält den beim Start geladenen
   Code). Neustart ist disruptiv (Terminals/Sessions) — nur mit Freigabe.
5. Rollback = ein Revert-Commit; der einzelne Prompt-Bullet-Block ist ohne Zustandsänderung rückholbar.

## 7. Abnahmekriterien

Replay-Harness über ≥ 200 reloggte Antworten: ≥25-Wort-Anteil der Ausgabe **unter** dem des DRAFTS
(Ziel ≤ 22 %), Fragment-Anteil ≤ 2 %, M5-Median ≤ 1,10, noop-Quote nicht steigend, CJK-Guard unverändert
aktiv. Live-Kontrolle nach Deployment: 20 aufeinanderfolgende deutsche Antworten von Hand gegen
die Tabelle in §2 lesen. Erst danach über weitere Schritte aus `llms/context-rot-language-decay.md`
(Attributionstest A–D) entscheiden.
