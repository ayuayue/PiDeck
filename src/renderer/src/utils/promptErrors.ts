class PromptDeliveryUnknownError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PromptDeliveryUnknownError";
	}
}

export { PromptDeliveryUnknownError };
