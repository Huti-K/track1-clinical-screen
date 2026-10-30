import { createContext, useContext } from "react";

/** The ID of the patient on display; documents are fetched for this patient only. */
export const PatientContext = createContext<string | undefined>(undefined);

export const usePatientId = () => useContext(PatientContext);
