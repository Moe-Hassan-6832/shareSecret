import { CreateSecret } from "@/types/CreateSecretRequest";
import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { publicEncrypt, randomUUID, subtle } from "crypto";
import { aesGcmDecrypt, aesGcmEncrypt } from "@/utils/encryption";

const client = new DynamoDBClient({
	credentials: {
		accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
	},
	region: process.env.AWS_REGION,
});

export async function GET(request: NextRequest) {
	const publicId = request.nextUrl.searchParams.get("publicId");
	const encryptionKey = request.nextUrl.searchParams.get("encryptionKey");

	if (!publicId) {
		return NextResponse.json({ error: "Missing public id" }, { status: 400 });
	}

	const item = await client.send(
		new GetItemCommand({
			TableName: "shareSecretsDb",
			Key: {
				publicId: { S: publicId },
			},
			ProjectionExpression: "secret, viewed",
		})
	);

	if (!item.Item) {
		return NextResponse.json({ error: "Secret not found" }, { status: 404 });
	}

	if (item.Item["viewed"]["BOOL"]) {
		return NextResponse.json({ error: "Secret already viewed" }, { status: 400 });
	}

	await client.send(
		new UpdateItemCommand({
			TableName: "shareSecretsDb",
			Key: {
				publicId: { S: publicId },
			},
			AttributeUpdates: {
				viewed: {
					Action: "PUT",
					Value: {
						BOOL: true,
					},
				},
			},
		})
	);

	const secret = item.Item["secret"]["S"]!;
	const data = await aesGcmDecrypt(secret, encryptionKey!);
	return NextResponse.json({ message: data }, { status: 200 });
}

export async function POST(request: NextRequest) {
	const data = await request.json();
	const result = await CreateSecret.safeParseAsync(data);
	if (!result.success) {
		return NextResponse.json({ error: "Invalid request body", details: result.error.issues }, { status: 400 });
	}

	const item = result.data;
	const publicId = crypto.randomUUID().toString();

	const encryptionKey = crypto.randomUUID().toString();
	const encryptedSecret = await aesGcmEncrypt(item.secret, encryptionKey);

	await client.send(
		new PutItemCommand({
			TableName: "shareSecretsDb",
			Item: {
				publicId: { S: publicId },
				secret: { S: encryptedSecret },
				sentBy: { S: item.sendMethod ?? "" },
				extraInfoToReceiver: { S: item.extraInfoToReceiver ?? "" },
				receiverEmail: { S: item.receiverEmail ?? "" },
				viewed: { BOOL: false },
			},
		})
	);

	// encryptionKey is never stored in the DB, it's returned to the user
	// in order to be appended to the url.
	return NextResponse.json({ publicId, encryptionKey }, { status: 201 });
}

export const runtime = "edge";
