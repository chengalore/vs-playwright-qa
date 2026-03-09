export function startPDCWatcher(page) {
  const pdcData = {
    store: "unknown",
    productType: "unknown",
    gender: "unknown",
    noVisor: false,
    validProduct: undefined,
    isKid: false,
  };

  page.on("response", async (response) => {
    if (!response.url().includes("product/check")) return;

    const json = await response.json().catch(() => null);
    if (!json?.data) return;

    // Prefer valid responses over invalid ones
    if (json.data.validProduct === true || pdcData.validProduct === undefined) {
      pdcData.store = json.data.storeName || pdcData.store;
      pdcData.productType = json.data.productTypeName || pdcData.productType;
      pdcData.validProduct = json.data.validProduct;
    }

    pdcData.gender =
      json.productData?.storeProductMeta?.gender || pdcData.gender;

    pdcData.noVisor =
      json.data.noVisor ||
      json.productData?.storeProductMeta?.noVisor ||
      pdcData.noVisor;

    pdcData.isKid =
      json.data.isKid ||
      json.productData?.storeProductMeta?.isKid ||
      pdcData.isKid;

    console.log(
      "PDC UPDATE:",
      pdcData.validProduct,
      pdcData.productType
    );
  });

  return pdcData;
}
