import { OpenApi } from "effect/http-api"
import { writeFileSync } from "node:fs"
import { EphemApi } from "../packages/api/src/index.ts"
writeFileSync(
  new URL("../reference/openapi.json", import.meta.url),
  JSON.stringify(OpenApi.fromApi(EphemApi), null, 1) + "\n",
)
