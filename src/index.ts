/**
 * Support Feedback Processor
 * 
 * Processes support feedback via HTTP POST or Queue:
 * 1. Uses AI to categorize and detect sentiment
 * 2. Looks up solutions in the database
 * 3. Sends appropriate email response
 * 4. Records the complaint in the database
 */

interface ComplaintMessage {
	customer_email: string;
	text: string;
}

interface Env {
	DB: D1Database;
	AI: Ai;
}

/**
 * Shared function to process a complaint message
 * Used by both HTTP POST endpoint and Queue consumer
 */
async function processComplaint(
	complaint: ComplaintMessage,
	env: Env
): Promise<{ success: boolean; normalized_key: string; sentiment: string; answer_type: string; emailResponse: string }> {
	const { customer_email, text } = complaint;

	// Step 1: Use AI to categorize and detect sentiment
	const aiPrompt = `Analyze the following customer support message and provide:
1. Category: one of "billing", "technical", or "general"
2. Sentiment: one of "positive", "neutral", or "negative"

Message: "${text}"

Respond in JSON format:
{
  "normalized_key": "billing|technical|general",
  "sentiment": "positive|neutral|negative"
}`;

	const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
		prompt: aiPrompt,
		max_tokens: 200,
		temperature: 0.3,
	});

	// Parse AI response
	let normalized_key = 'general';
	let sentiment = 'neutral';

	if (aiResponse.response) {
		try {
			// Try to extract JSON from the response
			const jsonMatch = aiResponse.response.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]);
				normalized_key = parsed.normalized_key || normalized_key;
				sentiment = parsed.sentiment || sentiment;
			} else {
				// Fallback: try to extract values from text
				const keyMatch = aiResponse.response.match(/normalized_key["\s:]+(billing|technical|general)/i);
				const sentimentMatch = aiResponse.response.match(/sentiment["\s:]+(positive|neutral|negative)/i);
				if (keyMatch) normalized_key = keyMatch[1].toLowerCase();
				if (sentimentMatch) sentiment = sentimentMatch[1].toLowerCase();
			}
		} catch (e) {
			console.error('Error parsing AI response:', e);
			// Use defaults if parsing fails
		}
	}

	// Step 2: Check the Solutions table for a matching normalized_key
	const solutionResult = await env.DB.prepare(
		'SELECT solution_text FROM Solutions WHERE normalized_key = ?'
	)
		.bind(normalized_key)
		.first<{ solution_text: string }>();

	let emailResponse: string;
	let answer_type: string;

	if (solutionResult && solutionResult.solution_text) {
		// Found a solution in the database
		emailResponse = solutionResult.solution_text;
		answer_type = 'KNOWN_SOLUTION';
	} else {
		// No solution found, send stock reply
		emailResponse = `Thank you for contacting support. We have received your message regarding "${normalized_key}" and will get back to you soon.`;
		answer_type = 'STOCK';
	}

	// Step 3: 'Send' email (console.log the response)
	console.log('=== EMAIL SENT ===');
	console.log(`To: ${customer_email}`);
	console.log(`Subject: Re: Your Support Request`);
	console.log(`Body: ${emailResponse}`);
	console.log('==================');

	// Step 4: Insert the final result into the Complaints table
	await env.DB.prepare(
		`INSERT INTO Complaints 
		(customer_email, text, sentiment, normalized_key, answer_type, answered) 
		VALUES (?, ?, ?, ?, ?, ?)`
	)
		.bind(customer_email, text, sentiment, normalized_key, answer_type, true)
		.run();

	return {
		success: true,
		normalized_key,
		sentiment,
		answer_type,
		emailResponse,
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Analytics Dashboard API - GET endpoint
		if (request.method === 'GET') {
			try {
				// Query 1: Total number of complaints
				const totalResult = await env.DB.prepare(
					'SELECT COUNT(*) as total FROM Complaints'
				).first<{ total: number }>();

				// Query 2: Count of Positive vs Negative sentiment
				const sentimentResult = await env.DB.prepare(
					`SELECT 
						SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) as positive_count,
						SUM(CASE WHEN sentiment = 'negative' THEN 1 ELSE 0 END) as negative_count
					FROM Complaints`
				).first<{ positive_count: number; negative_count: number }>();

				// Query 3: Percentage of complaints answered with KNOWN_SOLUTION vs STOCK
				const answerTypeResult = await env.DB.prepare(
					`SELECT 
						COUNT(*) as total,
						SUM(CASE WHEN answer_type = 'KNOWN_SOLUTION' THEN 1 ELSE 0 END) as known_solution_count,
						SUM(CASE WHEN answer_type = 'STOCK' THEN 1 ELSE 0 END) as stock_count
					FROM Complaints`
				).first<{ total: number; known_solution_count: number; stock_count: number }>();

				const total = totalResult?.total || 0;
				const positiveCount = sentimentResult?.positive_count || 0;
				const negativeCount = sentimentResult?.negative_count || 0;
				const knownSolutionCount = answerTypeResult?.known_solution_count || 0;
				const stockCount = answerTypeResult?.stock_count || 0;

				// Calculate percentages
				const knownSolutionPercentage = total > 0 ? ((knownSolutionCount / total) * 100).toFixed(2) : '0.00';
				const stockPercentage = total > 0 ? ((stockCount / total) * 100).toFixed(2) : '0.00';

				// Build JSON response
				const analytics = {
					total_complaints: total,
					sentiment: {
						positive: positiveCount,
						negative: negativeCount,
					},
					answer_types: {
						known_solution: {
							count: knownSolutionCount,
							percentage: parseFloat(knownSolutionPercentage),
						},
						stock: {
							count: stockCount,
							percentage: parseFloat(stockPercentage),
						},
					},
				};

				// Check if client wants HTML (via Accept header or query parameter)
				const url = new URL(request.url);
				const wantsHtml = url.searchParams.get('format') === 'html' || 
					request.headers.get('Accept')?.includes('text/html');

				if (wantsHtml) {
					// Return HTML visualization
					const html = `
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Support Analytics Dashboard</title>
	<style>
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
			max-width: 1200px;
			margin: 0 auto;
			padding: 20px;
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			min-height: 100vh;
		}
		.container {
			background: white;
			border-radius: 12px;
			padding: 30px;
			box-shadow: 0 10px 40px rgba(0,0,0,0.1);
		}
		h1 {
			color: #333;
			text-align: center;
			margin-bottom: 30px;
			font-size: 2.5em;
		}
		.stats-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
			gap: 20px;
			margin-bottom: 30px;
		}
		.stat-card {
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			color: white;
			padding: 25px;
			border-radius: 10px;
			box-shadow: 0 4px 6px rgba(0,0,0,0.1);
		}
		.stat-card h2 {
			margin: 0 0 10px 0;
			font-size: 1.2em;
			opacity: 0.9;
		}
		.stat-card .value {
			font-size: 2.5em;
			font-weight: bold;
			margin: 0;
		}
		table {
			width: 100%;
			border-collapse: collapse;
			margin-top: 20px;
			background: white;
			border-radius: 8px;
			overflow: hidden;
			box-shadow: 0 2px 8px rgba(0,0,0,0.1);
		}
		thead {
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			color: white;
		}
		th, td {
			padding: 15px;
			text-align: left;
		}
		th {
			font-weight: 600;
			text-transform: uppercase;
			font-size: 0.9em;
			letter-spacing: 0.5px;
		}
		tbody tr {
			border-bottom: 1px solid #eee;
		}
		tbody tr:hover {
			background: #f5f5f5;
		}
		tbody tr:last-child {
			border-bottom: none;
		}
		.percentage {
			font-weight: bold;
			color: #667eea;
		}
		.json-link {
			text-align: center;
			margin-top: 20px;
		}
		.json-link a {
			color: #667eea;
			text-decoration: none;
			font-weight: 600;
		}
		.json-link a:hover {
			text-decoration: underline;
		}
	</style>
</head>
<body>
	<div class="container">
		<h1>📊 Support Analytics Dashboard</h1>
		
		<div class="stats-grid">
			<div class="stat-card">
				<h2>Total Complaints</h2>
				<p class="value">${total}</p>
			</div>
			<div class="stat-card">
				<h2>Positive Sentiment</h2>
				<p class="value">${positiveCount}</p>
			</div>
			<div class="stat-card">
				<h2>Negative Sentiment</h2>
				<p class="value">${negativeCount}</p>
			</div>
		</div>

		<table>
			<thead>
				<tr>
					<th>Metric</th>
					<th>Count</th>
					<th>Percentage</th>
				</tr>
			</thead>
			<tbody>
				<tr>
					<td><strong>Known Solution</strong></td>
					<td>${knownSolutionCount}</td>
					<td><span class="percentage">${knownSolutionPercentage}%</span></td>
				</tr>
				<tr>
					<td><strong>Stock Reply</strong></td>
					<td>${stockCount}</td>
					<td><span class="percentage">${stockPercentage}%</span></td>
				</tr>
			</tbody>
		</table>

		<div class="json-link">
			<a href="?format=json">View as JSON</a>
		</div>
	</div>
</body>
</html>`;

					return new Response(html, {
						headers: { 'Content-Type': 'text/html;charset=UTF-8' },
					});
				}

				// Return JSON response
				return new Response(JSON.stringify(analytics, null, 2), {
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (error) {
				console.error('Error fetching analytics:', error);
				return new Response(
					JSON.stringify({ error: 'Failed to fetch analytics' }),
					{ status: 500, headers: { 'Content-Type': 'application/json' } }
				);
			}
		}

		// POST endpoint to receive feedback directly (works on free plan)
		if (request.method === 'POST') {
			try {
				const body = await request.json() as ComplaintMessage;

				// Validate request body
				if (!body.customer_email || !body.text) {
					return new Response(
						JSON.stringify({ error: 'Missing required fields: customer_email and text' }),
						{ status: 400, headers: { 'Content-Type': 'application/json' } }
					);
				}

				// Process the complaint
				const result = await processComplaint(body, env);

				return new Response(
					JSON.stringify({
						success: true,
						message: 'Complaint processed successfully',
						result: {
							normalized_key: result.normalized_key,
							sentiment: result.sentiment,
							answer_type: result.answer_type,
							email_sent: true,
						},
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}
				);
			} catch (error) {
				console.error('Error processing POST request:', error);
				return new Response(
					JSON.stringify({ error: 'Failed to process complaint', details: error instanceof Error ? error.message : 'Unknown error' }),
					{ status: 500, headers: { 'Content-Type': 'application/json' } }
				);
			}
		}

		// For other methods, return 405 Method Not Allowed
		return new Response('Method not allowed', { status: 405 });
	},

	async queue(batch: MessageBatch, env: Env): Promise<void> {
		// Process each message in the batch (optional - requires paid plan)
		// This will work when you upgrade to Workers Paid plan
		for (const message of batch.messages) {
			try {
				const complaint = message.body as ComplaintMessage;
				await processComplaint(complaint, env);
				// Acknowledge the message
				message.ack();
			} catch (error) {
				console.error('Error processing queue message:', error);
				// Retry the message on error
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<Env>;
