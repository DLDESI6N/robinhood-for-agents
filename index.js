import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import dotenv from "dotenv";

dotenv.config();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function saveDailyLog(content) {
  try {
    const logsDir = "./logs";
    await fs.mkdir(logsDir, { recursive: true });
    const dateStr = new Date().toISOString().split("T")[0];
    const fileName = `${logsDir}/briefing-${dateStr}.md`;
    
    await Bun.write(fileName, content); 
    console.log(`\nDaily briefing successfully saved to: ${fileName}`);
  } catch (error) {
    console.error("Failed to save daily log:", error);
  }
}

async function main() {
  console.log("Connecting to MCP Servers (Robinhood & Yahoo Finance)...");

  const rhTransport = new StdioClientTransport({
    command: "bun",
    args: ["bin/robinhood-for-agents.ts"], 
  });
  const rhClient = new Client(
    { name: "robinhood-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await rhClient.connect(rhTransport);

  const yfTransport = new StdioClientTransport({
    command: "bunx",
    args: ["yahoo-finance-mcp"], 
  });
  const yfClient = new Client(
    { name: "yahoo-finance-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await yfClient.connect(yfTransport);

  console.log("Connected to both servers! Fetching tool registries...");

  const rhToolsList = await rhClient.listTools();
  const allowedRhToolNames = ["get_account", "get_portfolio", "get_positions", "place_stock_order"];
  const filteredRhTools = rhToolsList.tools.filter(tool => 
    allowedRhToolNames.some(name => tool.name.includes(name))
  );

  const yfToolsList = await yfClient.listTools();
  
  const allMcpTools = [...filteredRhTools, ...yfToolsList.tools];
  console.log(`Loaded ${filteredRhTools.length} Robinhood tools and ${yfToolsList.tools.length} Yahoo tools.`);

  const mcpGeminiTools = allMcpTools.map(tool => {
    const formattedProperties = {};
    if (tool.inputSchema?.properties) {
      for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
        formattedProperties[key] = {
          type: mapTypeToGemini(prop.type),
          description: prop.description || "",
        };
      }
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: Type.OBJECT,
        properties: formattedProperties,
        required: tool.inputSchema.required || []
      }
    };
  });

  const ai = new GoogleGenAI({});
  const modelName = "gemini-3.1-pro-preview"; 

  const tradingSystemInstruction = `
    You are the "Silly Stock Selector," an autonomous algorithmic trading assistant. You embody a highly disciplined, laser-focused stock day trader. Your core objective is to safely compound a 10% monthly return. Capital preservation is your highest priority.

    CRITICAL EXECUTION RULE: 
    Do NOT output any text asking for human confirmation, review, or permission. You MUST actively execute trades autonomously.

    DATA GATHERING REQUIRED (IN EXACT ORDER):
    1. Market Sentiment: Use the Yahoo Finance tools to check current SPY/QQQ pre-market futures or daily VWAP. (CRITICAL: When using Yahoo tools, you MUST query only ONE ticker symbol at a time. Never pass an array of tickers).
    2. Stock Candidates: Query Yahoo Finance for live quotes, historical data, and earnings. 
    3. Account Sync: Call the Robinhood account retrieval tool to get your exact alphanumeric account number and 'buying_power'.

    GLOBAL GUARDRAILS & OPERATIONAL RULES:
    1. Bear Day Lockout (No-Trade): Do NOT execute trades if SPY/QQQ pre-market futures are down > 1.1%. If running at 3:00 PM, halt trading if SPY is below daily VWAP.
    2. Strategy Collision (45% Overlap Rule): If a stock meets criteria for multiple strategies, max combined allocation is 45% of the account.
    3. Execution Safety: Market orders are BANNED in the pre-market and post-market. You must use Marketable Limit Orders.
    4. Max Sizing: Total deployed capital combined must NEVER exceed 98%.
    5. Max Spread Limit (Illiquidity Guard): You MUST calculate the distance between the Bid and Ask prices. If the Bid-Ask spread is greater than $0.15 (or 0.25% of the asset's price), ABORT the trade for that ticker entirely. Do not buy illiquid assets.
    6. Price Sanity Check: Your calculated limit price (Ask + $0.05) must NEVER exceed the 'regularMarketPrice' or 'postMarketPrice' by more than 0.5%.
    7. Yahoo Tool Glitch Fallback: If a Yahoo Finance tool returns an error, fails to execute, or cannot pull historical 'back check' data, completely IGNORE Yahoo for that specific data point and immediately use the googleSearch tool instead to find the information.

    ROBINHOOD API CONSTRAINTS:
    - You must pass the exact alphanumeric account number retrieved from the account tool.
    - Fractional shares (Strategies 3 & 4 ONLY) require a "market" order. Limit orders for fractional shares will fail.
    - Do NOT place Take-Profit/Stop-Loss orders yet. Place BUY orders only.

    STRATEGIES:
    Strategy 1: Tech & Small-Cap Surge (Whole Shares ONLY)
    - Triggers: Tech sector ($300M - $10B cap), 1-mo momentum > +10%, intraday RSI > 55, RVOL > 2.0x, higher lows.
    - Exit: 50% at +4.0%. Stop-Loss: -2.5% trailing on remainder. Liquidate by 10:30 AM.

    Strategy 2: The Earnings Catalyst (Whole Shares ONLY)
    - Triggers: BMO or AMC yesterday, beat revenue, raised guidance, RVOL > 2.0x.
    - Exit: Limit at Avg Historical Positive Move x 0.75. Stop-Loss: -3.0%. Liquidate by 10:15 AM.

    Strategy 3: General News Breakout (Fractional ALLOWED)
    - Triggers: Verifiable news within 24hrs, 1-mo > +5%, RVOL > 1.5x, spread < 0.25%.
    - Exit: Limit at +5.0%. Stop-Loss: -2.5%. Liquidate by 10:30 AM.

    Strategy 4: Intraday VWAP Continuation (Fractional ALLOWED)
    - Triggers: > 1M avg volume, above 20/50 SMA. Pulls back to VWAP on low vol, RSI ~50.
    - Exit: Limit at +3.0%. Stop-Loss: -1.5% below VWAP. Liquidate by 11:00 AM.

    OUTPUT FORMAT:
    ## 📅 Daily Briefing: Silly Stock Selector
    **Total Buying Power:** $[Buying Power] | **Invested Capital:** $[Amount Invested]
    **Pre-Market Sentiment:** [Brief overview]
    ---
    ### Strategy [X]: [Ticker] - [Strategy Name] ([Whole/Fractional] Shares)
    * **Rationale:** [Technical justification]
    * **Entry:** [Market/Limit] Order ([X] shares)
  `;

  let chat = ai.chats.create({
    model: modelName,
    config: {
      tools: [
        { functionDeclarations: mcpGeminiTools },
        { googleSearch: {} } 
      ],
      toolConfig: { includeServerSideToolInvocations: true },
      systemInstruction: tradingSystemInstruction,
      temperature: 0.1 
    }
  });

  console.log(`Analyzing market conditions and executing strategies...`);
  
  let response = await chat.sendMessage({ 
    message: "Begin daily market analysis. Use Yahoo Finance for quotes/data and Google Search as a backup. Calculate allocations, and execute BUY trades via Robinhood." 
  });

  while (response.functionCalls && response.functionCalls.length > 0) {
    let toolResponses = [];

    for (const call of response.functionCalls) {
      console.log(`\nExecuting tool: ${call.name} with arguments:`, JSON.stringify(call.args));
      
      let toolResult;
      let toolExecuted = false;

      try {
        if (filteredRhTools.some(t => t.name === call.name)) {
          toolResult = await rhClient.callTool({ name: call.name, arguments: call.args });
          toolExecuted = true;
        } else if (yfToolsList.tools.some(t => t.name === call.name)) {
          toolResult = await yfClient.callTool({ name: call.name, arguments: call.args });
          toolExecuted = true;
        }

        if (toolExecuted) {
          console.log(`Tool Response:`, JSON.stringify(toolResult, null, 2));
          toolResponses.push({
            functionResponse: {
              name: call.name,
              response: { result: toolResult }
            }
          });
        }
      } catch (error) {
        console.error(`\n[!] Error executing ${call.name}:`, error.message);
        // Pivot Instruction injected directly into the chat history
        toolResponses.push({
          functionResponse: {
            name: call.name,
            response: { 
              error: `Tool execution failed: ${error.message}. If this is a Yahoo Finance tool issue or it lacks historical data, ABANDON this tool immediately and use googleSearch to find the data instead.` 
            }
          }
        });
      }
    }

    if (toolResponses.length > 0) {
      response = await chat.sendMessage({ message: toolResponses });
    } else {
      response = await chat.sendMessage({ message: "Continue." });
    }
  }

  let finalLogContent = response.text;

  if (!response.text.includes("NO TRADE")) {
    console.log("\n--------------------------------------------------");
    console.log("Buy orders placed. Pausing for market execution...");
    console.log("--------------------------------------------------");

    await sleep(400000); 

    console.log("Resuming: Staging exit bracket orders...");
    
    let followUpResponse = await chat.sendMessage({
      message: "Check filled shares via get_positions, and immediately place corresponding Take-Profit and Stop-Loss sell orders."
    });

    while (followUpResponse.functionCalls && followUpResponse.functionCalls.length > 0) {
      let followUpToolResponses = [];
      
      for (const call of followUpResponse.functionCalls) {
        console.log(`\nExecuting tool: ${call.name} with arguments:`, JSON.stringify(call.args));
        
        let toolResult;
        try {
          if (filteredRhTools.some(t => t.name === call.name)) {
            toolResult = await rhClient.callTool({ name: call.name, arguments: call.args });
            console.log(`Tool Response:`, JSON.stringify(toolResult, null, 2));
            followUpToolResponses.push({
              functionResponse: { name: call.name, response: { result: toolResult } }
            });
          }
        } catch (error) {
          console.error(`\n[!] Error executing ${call.name}:`, error.message);
          followUpToolResponses.push({
            functionResponse: { name: call.name, response: { error: error.message } }
          });
        }
      }

      if (followUpToolResponses.length > 0) {
         followUpResponse = await chat.sendMessage({ message: followUpToolResponses });
      } else {
         followUpResponse = await chat.sendMessage({ message: "Continue." });
      }
    }
    
    finalLogContent += "\n\n### Phase 2: Exit Brackets Executed\n" + followUpResponse.text;
    
    console.log("\n--------------------------------------------------");
    console.log(followUpResponse.text);
    console.log("--------------------------------------------------");
  } else {
    console.log("\n--------------------------------------------------");
    console.log(response.text);
    console.log("--------------------------------------------------");
  }

  await saveDailyLog(finalLogContent);

  await rhClient.close();
  await yfClient.close();
}

function mapTypeToGemini(jsonType) {
  switch (jsonType?.toLowerCase()) {
    case 'string': return Type.STRING;
    case 'number': return Type.NUMBER;
    case 'integer': return Type.INTEGER;
    case 'boolean': return Type.BOOLEAN;
    case 'array': return Type.ARRAY;
    case 'object': return Type.OBJECT;
    default: return Type.STRING;
  }
}

main().catch(console.error);