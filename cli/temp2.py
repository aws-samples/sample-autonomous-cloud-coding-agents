import boto3, webbrowser, json

REGION = 'us-east-1'  # Same Region you deployed to
WORKLOAD_IDENTITY_NAME = 'abca-agent'
CREDENTIAL_PROVIDER_NAME = 'abca-github'

client = boto3.client('bedrock-agentcore', region_name=REGION)

control_client = boto3.client('bedrock-agentcore-control', region_name=REGION)
response = control_client.get_workload_identity(name=WORKLOAD_IDENTITY_NAME)
print(json.dumps(response, indent=2, default=str))

# Step 1: get a workload access token
wat = client.get_workload_access_token(workloadName=WORKLOAD_IDENTITY_NAME)
token = wat['workloadAccessToken']

# Step 2: initiate the USER_FEDERATION flow
resp = client.get_resource_oauth2_token(
    workloadIdentityToken=token,
    resourceCredentialProviderName=CREDENTIAL_PROVIDER_NAME,
    scopes=['repo'],
    oauth2Flow='USER_FEDERATION',
    resourceOauth2ReturnUrl='https://localhost',
)

if resp.get('accessToken'):
    print('Consent already completed — token available.')
else:
    url = resp['authorizationUrl']
    session_uri = resp['sessionUri']
    print(f'Open this URL to authorize the GitHub App:\n{url}')
    webbrowser.open(url)
    input('\nAfter approving in the browser, press Enter to finalize...')

    # Step 3: complete the consent
    client.complete_resource_token_auth(
        userIdentifier={'userToken': token},
        sessionUri=session_uri,
    )
    print('Consent completed successfully.')
