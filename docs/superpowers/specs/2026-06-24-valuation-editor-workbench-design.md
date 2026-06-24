# Valuation Editor Workbench Redesign

## Goal

Redesign the add/edit valuation page into a clean white-gray workbench close to the provided reference: a method header, a left inputs panel, and a larger right results area with summary, chart, and sensitivity/advanced panels.

The redesign is visual and structural. It should reuse the existing valuation math and persistence contracts.

## Scope

- Replace the current narrow `vc-main` plus sticky `vc-side` valuation editor layout with a full workbench layout.
- Keep existing model definitions, `runModel`, schedules, breakdowns, derivations, segment aggregation, resource-asset calculations, note saving, and `onDone` payload shape.
- Show advanced modules only when the selected method/mode needs them.
- Make the page usable on desktop and mobile.

Out of scope:

- Changing valuation formulas.
- Changing saved valuation data schema.
- Adding server APIs.
- Redesigning the watchlist/detail pages outside the valuation editor.

## Layout

The valuation editor becomes a self-contained workspace inside `#viewValEdit`.

Desktop structure:

1. Header row
   - Back link.
   - Current method name as the main title, for example `P/E Ratio`.
   - Method selector beside or under the title.
   - Optional mode tabs below the selector when a model exposes modes.

2. Workbench shell
   - Light gray page background.
   - Large white rounded container.
   - Left `Inputs` panel with a subtle gray fill.
   - Right results grid on white.

3. Left panel
   - Title: `Inputs`.
   - Section: base inputs for single-value fields.
   - Section: scenario assumptions for conservative/optimistic fields.
   - Field references, tips, and derivation controls stay near their field.
   - Save button pinned to the bottom of the panel on desktop.
   - Note field lives in the left panel near the bottom, above Save.

4. Right results grid
   - `Valuation Summary` card spanning the top.
   - Below it, two cards when content exists:
     - Year-by-year chart for models with `schedule`.
     - Sensitivity analysis for models that can produce a meaningful two-variable matrix.
   - If only one secondary panel is available, it spans or balances the available width.
   - Existing breakdown rows appear inside the summary card as compact supporting metrics.

Mobile structure:

- Stack in this order: header, valuation summary, inputs, advanced/method-specific panels, chart/sensitivity.
- Save button remains full width near the bottom of the inputs panel.
- Tables and sensitivity matrices scroll horizontally when needed.

## Method-Specific Content

Advanced content appears only for applicable methods:

- Segment build-up appears only for PE segment mode.
- Resource NAV/SOTP asset and commodity-price panels appear only for resource models.
- Derivation panels appear only for fields that have derivation metadata.
- Schedule chart appears only when `model.schedule` returns rows.
- Sensitivity analysis appears only when the selected model has enough numeric assumptions to vary.

When no valuation method is selected, the workbench shows an empty state asking the user to choose a method. Results cards show dashes and Save is disabled.

## Sensitivity Analysis

The first implementation should generate a generic 5x5 matrix from the active model when possible:

- Pick two eligible numeric assumption fields.
- Prefer dual fields over single fields because they represent assumptions.
- Use the current midpoint as the center value.
- Generate two conservative/lower steps and two optimistic/higher steps.
- Run the model for each cell and show the midpoint of the resulting low/high value.
- Highlight the center cell.

If a model does not have two suitable numeric fields, hide the sensitivity panel.

## Chart

Use existing `model.schedule` output for the year-by-year visualization:

- Render a simple SVG line/area chart.
- Label years and important values.
- For DDM, label the series as dividends.
- For DCF-like models, label the series as cash flow or profit based on model metadata where available.
- If no schedule exists, hide the chart card.

## Data Flow

- `mountValuationCalc` remains the public entry point.
- It still receives `ctx`, initial valuation data, references, verdict callback, and `onDone`.
- Field readers continue to build the same `inputs` object.
- Save continues to call:

```js
onDone({ method, inputs, derivations, segments, low, high, note })
```

- The result summary, chart, and sensitivity matrix all recompute from the same form data used by `runModel`.

## Styling

The editor intentionally departs from the project’s existing blueprint style for this page:

- Background: neutral light gray.
- Main panels: white and very light gray.
- Rounded rectangles are larger than the rest of the app to match the reference.
- Borders are subtle and low contrast.
- Primary action is a black full-width button.
- Typography is plain, dense, and utilitarian.

This visual style should be scoped to valuation-editor classes so the rest of ValuePort keeps its current design language.

## Testing

Manual checks:

- Add a PE valuation from scratch.
- Edit an existing PE valuation.
- Switch PE modes, including segment mode.
- Add/edit a DCF or DDM model and confirm schedule chart appears when expected.
- Add/edit a resource NAV/SOTP model and confirm asset panels appear only there.
- Confirm Save is disabled until the valuation range is valid.
- Confirm saved valuation card, selected fair range, and note still persist.
- Check desktop and mobile widths.

Automated checks:

- Existing unit tests should continue to pass.
- Add focused DOM tests only if current test setup can mount `valuation-ui.js` without large browser scaffolding; otherwise rely on existing valuation logic tests plus manual browser verification.
