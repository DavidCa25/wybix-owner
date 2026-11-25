import {Modal} from 'react-native';
import {WebQr} from './WebQr.web';
/** En web la cámara lee QR; un lector de código de barras USB o Bluetooth escribe en el buscador. */
export function Escaner({visible,titulo,alLeer,alCerrar}:{visible:boolean;titulo:string;alLeer:(s:string)=>void;alCerrar:()=>void;modo?:'qr'|'barras';pie?:string|null}){return <Modal visible={visible} animationType="none" onRequestClose={alCerrar}>{visible?<WebQr title={titulo} onRead={alLeer} onClose={alCerrar}/>:null}</Modal>;}
