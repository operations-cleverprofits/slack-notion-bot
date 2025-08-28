import { App, ExpressReceiver } from "@slack/bolt";
import { Client as Notion } from "@notionhq/client";

// ---------- Env ----------
const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  NOTION_TOKEN,
  ALLOWED_DATABASE_IDS
} = process.env;

const allowedDbSet = new Set(
  (ALLOWED_DATABASE_IDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

// ---------- Slack + Notion clients ----------
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  endpoints: "/slack/events",
});
const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver
});
const notion = new Notion({ auth: NOTION_TOKEN });

// ---------- Helpers ----------
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = s => s.replace(/\s+/g, " ").trim();

async function getTitlePropName(database_id) {
  const db = await notion.databases.retrieve({ database_id });
  const entries = Object.entries(db.properties);
  const titleEntry = entries.find(([, v]) => v.type === "title");
  if (!titleEntry) throw new Error("No title property found");
  return { name: titleEntry[0], db };
}

function dbAllowed(id) {
  if (allowedDbSet.size === 0) return true;
  return allowedDbSet.has(id);
}
function buildModal({ messageText, channel, ts, selectedDb }) {
  const titleDefault = truncate(oneLine(messageText || "New Task from Slack"), 80);

  return {
    type: "modal",
    callback_id: "push_to_notion_modal",
    private_metadata: JSON.stringify({ channel, ts, messageText, selectedDb }),
    title: { type: "plain_text", text: "Push to Notion" },
    submit: { type: "plain_text", text: "Create" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "db_block",
        label: { type: "plain_text", text: "Database" },
        element: {
          type: "external_select",
          action_id: "db_select",
          min_query_length: 0,
          placeholder: { type: "plain_text", text: "Search a Notion database..." },
          initial_option: selectedDb ? {
            text: { type: "plain_text", text: "Selected DB" },
            value: selectedDb
          } : undefined
        }
      },
      {
        type: "input",
        optional: true,
        block_id: "parent_block",
        label: { type: "plain_text", text: "Parent task (optional)" },
        element: {
          type: "external_select",
          action_id: "parent_select",
          min_query_length: 0,
          placeholder: { type: "plain_text", text: "Search a parent task (after selecting DB)" }
        }
      },
      {
        type: "input",
        block_id: "title_block",
        label: { type: "plain_text", text: "Title" },
        element: {
          type: "plain_text_input",
          action_id: "title_input",
          initial_value: titleDefault
        }
      },
      {
        type: "input",
        optional: true,
        block_id: "notes_block",
        label: { type: "plain_text", text: "Notes / Description" },
        element: {
          type: "plain_text_input",
          action_id: "notes_input",
          multiline: true,
          initial_value: messageText || ""
        }
      }
    ]
  };
}
app.shortcut("push_to_notion", async ({ shortcut, ack, client }) => {
  await ack();
  const message = shortcut.message || {};
  const channel = shortcut.channel?.id || shortcut.channel;
  const ts = message.ts || shortcut.message_ts;
  const text = message.text || "";

  await client.views.open({
    trigger_id: shortcut.trigger_id,
    view: buildModal({ messageText: text, channel, ts })
  });
});

app.options("db_select", async ({ options, ack }) => {
  const q = (options.value || "").trim();
  const res = await notion.search({
    query: q || undefined,
    filter: { value: "database", property: "object" },
    page_size: 25
  });

  const dbs = res.results
    .filter(d => d.object === "database")
    .filter(d => dbAllowed(d.id));

  const opts = dbs.map(d => ({
    text: { type: "plain_text", text: truncate(d.title?.[0]?.plain_text || d.id, 75) },
    value: d.id
  }));

  await ack({ options: opts });
});

app.action("db_select", async ({ ack }) => await ack());

app.options("parent_select", async ({ options, ack, body }) => {
  const meta = JSON.parse(body.view.private_metadata || "{}");
  const database_id = meta.selectedDb;
  if (!database_id) return await ack({ options: [] });

  const queryStr = (options.value || "").trim();
  const { name: titleProp } = await getTitlePropName(database_id);

  const res = await notion.databases.query({
    database_id,
    page_size: 25,
    filter: queryStr ? {
      property: titleProp,
      title: { contains: queryStr }
    } : undefined
  });

  const opts = res.results.map(p => {
    const title = (p.properties?.[titleProp]?.title?.[0]?.plain_text) || p.id.slice(0, 12);
    return {
      text: { type: "plain_text", text: truncate(title, 75) },
      value: p.id
    };
  });

  await ack({ options: opts });
});

app.view("push_to_notion_modal", async ({ ack, body, view, client }) => {
  const meta = JSON.parse(view.private_metadata || "{}");
  const state = view.state.values;

  const selectedDb = state.db_block?.db_select?.selected_option?.value || meta.selectedDb;
  if (!selectedDb) {
    return await ack({
      response_action: "errors",
      errors: { db_block: "Please select a Notion database." }
    });
  }

  const titleInput = state.title_block?.title_input?.value?.trim() || "New Task";
  const notesInput = state.notes_block?.notes_input?.value?.trim() || "";
  const parentSelected = state.parent_block?.parent_select?.selected_option?.value;

  const { name: titleProp, db } = await getTitlePropName(selectedDb);

  const relationPropEntry = Object.entries(db.properties).find(([propName, prop]) => {
    if (prop.type !== "relation") return false;
    return prop.relation?.database_id === selectedDb;
  });
  const relationPropName = relationPropEntry ? relationPropEntry[0] : null;

  const page = await notion.pages.create({
    parent: { database_id: selectedDb },
    properties: {
      [titleProp]: { title: [{ text: { content: titleInput } }] },
      ...(parentSelected && relationPropName ? {
        [relationPropName]: { relation: [{ id: parentSelected }] }
      } : {})
    }
  });

  let permalink = "";
  if (meta.channel && meta.ts) {
    try {
      const res = await client.chat.getPermalink({ channel: meta.channel, message_ts: meta.ts });
      permalink = res.permalink || "";
    } catch {}
  }

  const children = [];
  if (notesInput) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: notesInput } }] }
    });
  }
  if (permalink) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{
          type: "text",
          text: {
            content: "🔗 View original Slack message",
            link: { url: permalink }
          }
        }]
      }
    });
  }
  if (children.length) {
    await notion.blocks.children.append({ block_id: page.id, children });
  }

  await ack();
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log("⚡️ Slack app is running on port", port);
})();
