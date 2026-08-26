import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("Connecting to Robinhood MCP Server...");

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["bin/robinhood-for-agents.ts"], 
  });

  const mcpClient = new Client(
    { name: "silly-stock-picker-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await mcpClient.connect(transport);
  console.log("Connected successfully! Fetching tools...");

  const toolsList = await mcpClient.listTools();

  // Added order-placing tools to the allowed list
  const allowedToolNames = [
    "get_account", 
    "get_portfolio", 
    "get_positions",
    "place_equity_order" // <-- This allows Gemini to stage the orders
  ];

  const filteredTools = toolsList.tools.filter(tool => 
    allowedToolNames.some(name => tool.name.includes(name))
  );

  console.log(`Filtered down to ${filteredTools.length} essential trading tools.`);

  const geminiTools = filteredTools.map(tool => {
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

  const sillyStockSelectorPrompt = `
    You are the "Silly Stock Selector," an analytical day-trading and swing-trading assistant. 
    You deliver daily trade plans based strictly on the uploaded Knowledge Base rules.

    CORE OPERATING RULES:
    1. Budget Allocation: Enforce a $250.00 cash account structure:
       - Strategy 1 (Weekly Swing): $100.00 allocation (Hold: 2 to 5 days. Target Take-Profit: +5.0% to +8.0%, Stop-Loss: -3.0%).
       - Strategy 2 (Earnings Catalyst): $75.00 allocation (Intraday. Take-Profit formula: (Average Historical Positive Post-Earnings Move) * 0.75, Stop-Loss: -3.0%).
       - Strategy 3 (News Momentum): $75.00 allocation (Intraday. Take-Profit: +4.0% to +7.0% based on ATR, Stop-Loss: -2.5%).
    2. Safety & "No Trade" Filter: If pre-market index futures (SPY/QQQ) are down > 1.5%, or if no qualifying stocks meet criteria, declare a "NO TRADE / CAPITAL PRESERVATION" for that strategy.
    3. Real-Time Data: Analyze live pre-market prices, recent news catalysts, guidance commentary, and RVOL.

    OUTPUT FORMAT REQUIREMENT:
    You must format your final briefing strictly using this structure:

    ## 📅 Daily Briefing: Silly Stock Selector
    **Pre-Market Sentiment:** [Brief 1-2 sentence overview of SPY/QQQ futures and morning market conditions]

    ---

    ### 1️⃣ Strategy 1: [Ticker] - Weekly Swing Setup ($100 Allocation)
    * **Rationale & Technicals:** [Explain 20/50 SMA trend, RSI reading between 45-60, and weekly volume pattern >= 1M]
    * **Target Holding Period:** 2 to 5 days
    * **Entry Plan:** Buy Limit at $[Price]
    * **Exit Plan:** Take Profit at $[Price] (+X.X%) | Stop Loss at $[Price] (-3.0%)

    ---

    ### 2️⃣ Strategy 2: [Ticker] - Earnings Catalyst ($75 Allocation)
    * **Earnings Context:** [Report time, revenue beat, guidance status, and pre-market RVOL >= 2.0x]
    * **Safety Buffer Math:** [Historical avg move %] * 0.75 = [Target Gain %]
    * **Entry Plan:** Buy Limit at $[Price]
    * **Exit Plan:** Take Profit at $[Price] (+X.X%) | Stop Loss at $[Price] (-3.0%)

    ---

    ### 3️⃣ Strategy 3: [Ticker] - News & Momentum ($75 Allocation)
    * **Catalyst & Trend:** [Explain the last 24h news event, 1-month growth (+5-25%), and RVOL >= 1.5x]
    * **Entry Plan:** Buy Limit at $[Price]
    * **Exit Plan:** Take Profit at $[Price] (+X.X%) | Stop Loss at $[Price] (-2.5%)

    ---

    INSTRUCTION FOR EXECUTION:
    After generating the briefing above, verify buying power and use the 'place_equity_order' tool to stage the buy limit orders for each of the three qualifying strategies based on their exact budget allocations.
  `;

  let chat = ai.chats.create({
    model: "gemini-3.6-flash",
    config: {
      tools: [{ functionDeclarations: geminiTools }],
      systemInstruction: "You are a disciplined algorithmic trading assistant executing the Silly Stock Selector framework."
    }
  });

  console.log("Analyzing market conditions and executing stock selection strategy...");
  let response = await chat.sendMessage({ message: sillyStockSelectorPrompt });

  while (response.functionCalls && response.functionCalls.length > 0) {
    for (const call of response.functionCalls) {
      console.log(`\nExecuting Robinhood tool: ${call.name} with arguments:`, JSON.stringify(call.args));
      
      const toolResult = await mcpClient.callTool({
        name: call.name,
        arguments: call.args
      });

      response = await chat.sendMessage({
        message: [{
          functionResponse: {
            name: call.name,
            response: { result: toolResult }
          }
        }]
      });
    }
  }

  console.log("\n--------------------------------------------------");
  console.log(response.text);
  console.log("--------------------------------------------------");

  await mcpClient.close();
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