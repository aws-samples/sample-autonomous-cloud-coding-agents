import boto3, json

region = "us-east-1"
client = boto3.client("bedrock-agentcore", region_name=region)

# Step 1: Get workload access token
wat = client.get_workload_access_token(workloadName="abca-agent")
token = wat["workloadAccessToken"]

print(token)


sm = boto3.client("secretsmanager", region_name="us-east-1")
secrets = sm.list_secrets(Filters=[{"Key": "name", "Values": ["bedrock-agentcore-identity"]}])
for s in secrets["SecretList"]:
    if "abca-github" in s["Name"]:
        print(f"Secret: {s['Name']}")
        print(f"ARN: {s['ARN']}")
        try:
            policy = sm.get_resource_policy(SecretId=s["ARN"])
            print(f"Policy: {json.dumps(json.loads(policy.get('ResourcePolicy', '{}')), indent=2)}")
        except Exception as e:
            print(f"Policy error: {e}")
        try:
            sm.get_secret_value(SecretId=s["ARN"])
            print("Can read secret: YES")
        except Exception as e:
            print(f"Can read secret: NO - {e}")

# Step 2: Start USER_FEDERATION flow

try:
    resp = client.get_resource_oauth2_token(
        workloadIdentityToken=token,
        resourceCredentialProviderName="abca-github",
        scopes=["repo"],
        oauth2Flow="USER_FEDERATION",
    )
    print(json.dumps(resp, indent=2, default=str))
except Exception as e:
    print(f"Error: {e}")
print(json.dumps(resp, indent=2, default=str))
print("\nOpen the authorizationUrl above in your browser and approve.")
print("Then re-run this script with the sessionUri to complete the flow.")
