/**
 * DSH's dialog primitives, as the host lends them, for the render smoke test.
 *
 * The stub keeps the contract SeModal relies on — Modal with {open, onClose,
 * title, description, footer, children}, RiskConfirmation with the
 * acknowledgement pair — and renders real elements, so an assertion can see
 * which layer drew a dialog exactly as the app's own components would. The
 * plugin resolves this package through `require`; a host without it must fall
 * back rather than throw, which the dialog check exercises by deleting the two
 * members from the stub.
 *
 * It takes React rather than importing it so the smoke test keeps its own stub:
 * the bundle is compiled against a fake react, and nothing here should reach the
 * real one.
 *
 * @param {{ createElement: (type: any, props: any, ...children: any[]) => any }} React
 */
export function dialogPrimitives(React) {
  const { createElement } = React;
  return {
    Modal: (props) =>
      createElement(
        "div",
        { className: "dsh-modal-stub", "data-title": props.title, "data-open": String(props.open) },
        createElement("h2", { className: "dsh-modal-stub-title" }, props.title),
        props.description ? createElement("p", { className: "dsh-modal-stub-desc" }, props.description) : null,
        createElement("div", { className: "dsh-modal-stub-body" }, props.children),
        props.footer ? createElement("div", { className: "dsh-modal-stub-footer" }, props.footer) : null,
      ),
    RiskConfirmation: (props) =>
      createElement(
        "div",
        { className: "dsh-modal-stub dsh-risk-stub", "data-title": props.title },
        props.description ? createElement("p", { className: "dsh-risk-desc" }, props.description) : null,
        createElement(
          "label",
          { className: "dsh-risk-ack" },
          createElement("input", {
            type: "checkbox",
            checked: props.acknowledged === true,
            onChange: (event) => props.onAcknowledgedChange?.(event.target.checked),
          }),
          createElement("span", null, props.acknowledgeLabel),
        ),
        createElement(
          "div",
          { className: "dsh-modal-stub-footer" },
          createElement("button", { type: "button", className: "act", onClick: props.onCancel }, props.cancelLabel),
          createElement(
            "button",
            { type: "button", className: "act primary", disabled: props.acknowledged !== true, onClick: props.onConfirm },
            props.confirmLabel,
          ),
        ),
      ),
  };
}
