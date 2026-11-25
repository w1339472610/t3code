import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type PluginConfigValue } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT, useLocale } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { useStableCallback } from "~/hooks/useStableCallback";
import { buildThreadRouteParams } from "~/threadRoutes";

import {
  PLUGIN_BRIDGE_VERSION,
  readPluginMessage,
  type PluginInboundMessage,
} from "./pluginBridge";

// The opaque-origin frame cannot be addressed by origin, so "*" is the only target.
function postToFrame(frame: HTMLIFrameElement | null, type: string, payloadJson: string) {
  frame?.contentWindow?.postMessage(
    { t3: PLUGIN_BRIDGE_VERSION, type, ...JSON.parse(payloadJson) },
    "*",
  );
}

export function PluginNotice(props: { children: string }) {
  return (
    <p className="flex size-full items-center justify-center px-6 text-center text-muted-foreground text-xs">
      {props.children}
    </p>
  );
}

/**
 * Hosts one plugin document. `feeds` are pushed by type whenever their JSON changes and again
 * when the plugin (re)announces itself; messages the frame doesn't own go to `onMessage`.
 */
export function PluginFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly title: string;
  readonly entry: string;
  readonly surface: "panel" | "page";
  readonly threadId: string | null;
  readonly projectCwd: string | null;
  readonly config: Record<string, PluginConfigValue>;
  readonly canNavigate: boolean;
  readonly feeds: ReadonlyArray<readonly [type: string, json: string | null]>;
  readonly onMessage?: (message: PluginInboundMessage) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const theme = useHtmlRenderTheme();
  // A GT locale code such as "zh" or "pt-BR"; plugins pick their own strings from it.
  const locale = useLocale();
  const gt = useGT();
  const navigate = useNavigate();

  // The frame keeps its first URL: a re-minted one would reload the plugin.
  const [src, setSrc] = useState<string | null>(null);
  const asset = useLongLivedAssetUrl(src === null ? props.environmentId : null, {
    _tag: "plugin-file",
    pluginId: props.pluginId,
    path: props.entry,
  });
  if (src === null && asset._tag === "Success") setSrc(asset.url);

  const context = JSON.stringify({
    theme: theme.appearance,
    cssVars: theme.variables,
    locale,
    surface: props.surface,
    environmentId: props.environmentId,
    threadId: props.threadId,
    projectCwd: props.projectCwd,
    config: props.config,
  });
  const feeds: ReadonlyArray<readonly [string, string]> = [
    ["context", context],
    ...props.feeds.flatMap(([type, json]) => (json === null ? [] : [[type, json] as const])),
  ];
  const feedsKey = JSON.stringify(feeds);
  const posted = useRef(new Map<string, string>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes host state into the plugin's frame, which only hears postMessage
  useEffect(() => {
    if (!ready) return;
    for (const [type, json] of JSON.parse(feedsKey) as Array<[string, string]>) {
      if (posted.current.get(type) === json) continue;
      posted.current.set(type, json);
      postToFrame(frameRef.current, type, json);
    }
  }, [ready, feedsKey]);

  const onMessage = useStableCallback((event: MessageEvent) => {
    if (event.source === null || event.source !== frameRef.current?.contentWindow) return;
    const message = readPluginMessage(event.data);
    if (message === null) return;
    switch (message.type) {
      case "ready":
        // Every document announces itself, including one the plugin reloaded.
        posted.current.clear();
        for (const [type, json] of feeds) {
          posted.current.set(type, json);
          postToFrame(frameRef.current, type, json);
        }
        setReady(true);
        return;
      case "openThread":
        if (!props.canNavigate) return;
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(props.environmentId, ThreadId.make(message.threadId)),
          ),
        });
        return;
      default:
        props.onMessage?.(message);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window messages from the plugin frame
  useEffect(() => {
    const listener = (event: MessageEvent) => onMessage(event);
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onMessage]);

  if (src === null) {
    return asset._tag === "Failure" ? (
      <PluginNotice>{gt("Unable to load this plugin.")}</PluginNotice>
    ) : null;
  }
  return (
    <iframe
      ref={frameRef}
      src={src}
      title={props.title}
      // Omitting allow-same-origin keeps the plugin out of the session's cookies and storage.
      sandbox="allow-scripts allow-forms allow-popups"
      className="block size-full border-0"
      style={{ colorScheme: theme.appearance }}
    />
  );
}
