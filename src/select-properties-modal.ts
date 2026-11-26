// The property editor lives in commons so Perplexity Saver's duplicate-note
// merge can review properties with the same UI. Porter keeps its "pp" classes.
import type { App } from "obsidian";
import type { VaultMetadataCatalog } from "commons/properties";
import {
	SelectPropertiesModal as SharedSelectPropertiesModal,
	type ConflictCardContext,
	type SelectPropertiesModalOptions,
} from "commons/properties/review-modal";

export * from "commons/properties/review-modal";
export { propertyTypeLabel } from "commons/properties";

export class SelectPropertiesModal extends SharedSelectPropertiesModal {
	constructor(
		app: App,
		catalog: VaultMetadataCatalog,
		initialProperties: Record<string, unknown>,
		onSubmit: (selected: Record<string, unknown>) => void,
		onCancel: () => void,
		conflictContext: Record<string, ConflictCardContext> = {},
		options: SelectPropertiesModalOptions = {}
	) {
		super(app, catalog, initialProperties, onSubmit, onCancel, conflictContext, { classPrefix: "pp", ...options });
	}
}
