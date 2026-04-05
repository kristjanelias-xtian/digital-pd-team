# Handoff Protocol

Telegram bots cannot see messages from other bots. All cross-bot coordination goes through the webhook relay. This file is the single source of truth for how.

## When you hand off work to another bot

1. **Post to the group** with an @mention of the target bot. This is for Kristjan's visibility, not delivery.
2. **Send via the relay** — this is the actual delivery. Use the default (synchronous) mode; async mode is legacy and drops status.

```
curl -s -X POST http://192.168.5.2:3000/trigger \
  -H "Content-Type: application/json" \
  -d '{"to":"<bot-name>","from":"<your-name>","message":"<same text you posted to the group>"}'
```

Where `<bot-name>` is lowercase: `zeno`, `lux`, or `taro`.

The relay waits for real delivery. A response of `{"delivered":false}` means it didn't arrive — retry once, then DM Kristjan if still failing. Do not announce the failure in the group.

## When you are triggered via the relay

The trigger arrives as a plain text message. Respond normally. The webhook server automatically posts your response to the group — you do not need to re-post it yourself. (If you do re-post, you'll duplicate.)

## When you ack a handoff

When another bot assigns you work, acknowledge immediately by name. One line. Then do the work. Then post a completion line when done.

Example:
> "Got it @lux — looking at the Pirita Villa lead now."
> (work happens silently)
> "Pirita Villa: qualified Hot, converted to deal, notes on the record."

## Timeouts

If you trigger another bot and get no acknowledgment within ~2 minutes, send one reminder ping. Still nothing after another ~2 minutes — escalate to @zeno_pd_bot (or Kristjan if Zeno is the one not responding).

## Never

- Never announce relay errors, trigger failures, or delivery status in the group.
- Never say another bot is "silent" or "not responding" in the group — you have no way to observe Telegram messages from other bots.
- Never post the `curl` command or the relay URL in the group.
