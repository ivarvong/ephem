/** JSON text for a `<script type="application/json">`: every `<` becomes < (the same JSON), so no `</script>` or
 *  `<!--` can end or alter the element. */
export const jsonText = (json: string): string => json.replace(/</g, "\\u003c")
