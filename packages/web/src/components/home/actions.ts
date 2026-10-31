// What the homepage's controls do. The view (these components) renders on the server and in the browser; the controller
// (src/client/home/*) exists only in the browser, so it hands the view its actions through this context. On the server every
// action is a no-op (nothing is interactive before hydration).
import { createContext } from "preact"
import { useContext } from "preact/hooks"

export interface Actions {
  readonly goLive: () => void
  readonly recenter: () => void
  readonly point: () => void
  readonly locate: () => void
  readonly share: () => void
  readonly hoodToggle: () => void
  readonly rawToggle: (open: boolean) => void
  readonly mountSky: (section: HTMLElement) => void
  readonly mountStrip: (svg: SVGSVGElement | null) => void
  readonly stripDown: (e: PointerEvent) => void
  readonly stripMove: (e: PointerEvent) => void
  readonly stripEnd: (e: PointerEvent) => void
  readonly stripCancel: (e: PointerEvent) => void
  readonly stripKey: (e: KeyboardEvent) => void
}
const noop = () => {}
export const NO_ACTIONS: Actions = {
  goLive: noop, recenter: noop, point: noop, locate: noop, share: noop, hoodToggle: noop, rawToggle: noop, mountSky: noop, mountStrip: noop,
  stripDown: noop, stripMove: noop, stripEnd: noop, stripCancel: noop, stripKey: noop,
}
export const ActionsContext = createContext<Actions>(NO_ACTIONS)
export const useActions = () => useContext(ActionsContext)
