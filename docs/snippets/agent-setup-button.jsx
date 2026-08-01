export const AgentSetupButton = () => {
  const [status, setStatus] = useState("idle")
  const resetTimer = useRef(null)
  const visualButton = useRef(null)

  useEffect(() => {
    const nativeCopyButton = visualButton.current?.ownerDocument.querySelector(
      ".webcmd-native-copy-source button[aria-label='Copy the contents from the code block']"
    )

    if (!nativeCopyButton) return

    nativeCopyButton.setAttribute("aria-label", "Copy the Webcmd agent setup prompt")

    const showCopied = () => {
      setStatus("copied")
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setStatus("idle"), 1800)
    }

    nativeCopyButton.addEventListener("click", showCopied)

    return () => {
      nativeCopyButton.removeEventListener("click", showCopied)
      if (resetTimer.current) clearTimeout(resetTimer.current)
    }
  }, [])

  const label = status === "copied" ? "Prompt copied!" : "Copy prompt"

  return (
    <span
      ref={visualButton}
      className="webcmd-copy-prompt"
      data-copy-status={status}
      aria-hidden="true"
    >
      <span className="webcmd-agent-icons" aria-hidden="true">
        <img src="/icons/agents/claude.svg" alt="" noZoom />
        <img className="webcmd-agent-icon-mono" src="/icons/agents/codex.svg" alt="" noZoom />
        <img className="webcmd-agent-icon-mono" src="/icons/agents/cursor.svg" alt="" noZoom />
        <img className="webcmd-agent-icon-mono" src="/icons/agents/opencode.svg" alt="" noZoom />
      </span>
      <span aria-live="polite">{label}</span>
    </span>
  )
}
