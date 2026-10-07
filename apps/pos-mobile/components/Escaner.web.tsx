import {Modal} from 'react-native';
import {WebQr} from './WebQr.web';
export function Escaner({visible,titulo,alLeer,alCerrar}:{visible:boolean;titulo:string;alLeer:(s:string)=>void;alCerrar:()=>void}){return <Modal visible={visible} animationType="none" onRequestClose={alCerrar}>{visible?<WebQr title={titulo} onRead={alLeer} onClose={alCerrar}/>:null}</Modal>;}